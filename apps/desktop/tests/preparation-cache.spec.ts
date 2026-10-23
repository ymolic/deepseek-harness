/** Development preparation caches preserve complete resources across failures and competing writers. */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { preparationFingerprint, prepareCachedDirectories } from '../scripts/preparation-cache.ts'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-preparation-cache-')) })
afterEach(() => {
  vi.mocked(renameSync).mockReset()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

beforeEach(async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementation(fs.renameSync)
})

function preparation() {
  let identity = 'first'
  const prepare = vi.fn(async (staging: string) => {
    for (const name of ['one', 'two']) {
      mkdirSync(join(staging, name))
      writeFileSync(join(staging, name, 'content'), identity)
    }
  })
  return { options: { root, directories: ['one', 'two'], record: 'complete.json', identity: () => identity, prepare },
    prepare, change: () => { identity = 'later' } }
}

it('reuses complete byte-identical outputs without rewriting them', async () => {
  const { options, prepare } = preparation()
  await prepareCachedDirectories(options)
  const record = readFileSync(join(root, 'complete.json'), 'utf8')
  const timestamp = statSync(join(root, 'one')).birthtimeMs
  await prepareCachedDirectories(options)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(readFileSync(join(root, 'complete.json'), 'utf8')).toBe(record)
  expect(statSync(join(root, 'one')).birthtimeMs).toBe(timestamp)
})

it.each(['missing', 'truncated', 'same-length', 'extra', 'record'] as const)('repairs %s resources before reuse', async (damage) => {
  const { options, prepare } = preparation()
  await prepareCachedDirectories(options)
  const file = join(root, 'one', 'content')
  const original = statSync(file)
  if (damage === 'missing') rmSync(file)
  else if (damage === 'extra') writeFileSync(join(root, 'two', 'unexpected'), 'extra')
  else if (damage === 'record') writeFileSync(join(root, 'complete.json'), '{')
  else {
    writeFileSync(file, damage === 'truncated' ? '' : 'other')
    utimesSync(file, original.atime, original.mtime)
  }
  await prepareCachedDirectories(options)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(readFileSync(file, 'utf8')).toBe('first')
  expect(readdirSync(join(root, 'two'))).toEqual(['content'])
})

it('preserves previous resources and completion record when preparation fails', async () => {
  const { options, prepare, change } = preparation()
  await prepareCachedDirectories(options)
  const before = preparationFingerprint([join(root, 'one'), join(root, 'two')])
  const record = readFileSync(join(root, 'complete.json'), 'utf8')
  change()
  prepare.mockRejectedValueOnce(new Error('smoke failed'))
  await expect(prepareCachedDirectories(options)).rejects.toThrow('smoke failed')
  expect(preparationFingerprint([join(root, 'one'), join(root, 'two')])).toBe(before)
  expect(readFileSync(join(root, 'complete.json'), 'utf8')).toBe(record)
  expect(readdirSync(root).sort()).toEqual(['complete.json', 'one', 'two'])
  await prepareCachedDirectories(options)
  expect(readFileSync(join(root, 'one', 'content'), 'utf8')).toBe('later')
})

it('rejects inputs that change during preparation without publishing them', async () => {
  const { options, prepare, change } = preparation()
  const original = prepare.getMockImplementation()!
  prepare.mockImplementationOnce(async (staging) => { await original(staging); change() })
  await expect(prepareCachedDirectories(options)).rejects.toThrow('inputs changed during preparation')
  expect(readdirSync(root)).toEqual([])
})

it('restores both previous directories after a replacement fails midway', async () => {
  const { options, change } = preparation()
  await prepareCachedDirectories(options)
  const before = preparationFingerprint([join(root, 'one'), join(root, 'two')])
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  let failed = false
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (!failed && String(from).includes('.preparing-') && String(from).endsWith('two') && to === join(root, 'two')) {
      failed = true
      throw new Error('replacement blocked')
    }
    fs.renameSync(from, to)
  })
  change()
  await expect(prepareCachedDirectories(options)).rejects.toThrow('replacement blocked')
  expect(preparationFingerprint([join(root, 'one'), join(root, 'two')])).toBe(before)
  expect(readdirSync(root).sort()).toEqual(['complete.json', 'one', 'two'])
})

it('retains recoverable resources and reports both failures when restoration is blocked', async () => {
  const { options, change } = preparation()
  await prepareCachedDirectories(options)
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (String(from).includes('.previous-')) throw new Error('restoration blocked')
    if (String(from).includes('.preparing-') && to === join(root, 'two')) throw new Error('replacement blocked')
    fs.renameSync(from, to)
  })
  change()
  await expect(prepareCachedDirectories(options)).rejects.toThrow('replacement and restoration failed')
  const retained = readdirSync(root).find(name => name.startsWith('.preparing-'))!
  expect(readFileSync(join(root, retained, '.previous-one/content'), 'utf8')).toBe('first')
  expect(readFileSync(join(root, retained, '.previous-two/content'), 'utf8')).toBe('first')
})

it('rejects cyclic source resources instead of recursing through their directory links', () => {
  const source = join(root, 'source')
  mkdirSync(source)
  symlinkSync(source, join(source, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => preparationFingerprint([source], true)).toThrow('cyclic resource directory')
})

it('serializes concurrent preparations and checks the completed output again', async () => {
  const { options, prepare } = preparation()
  await Promise.all([prepareCachedDirectories(options), prepareCachedDirectories(options)])
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(readFileSync(join(root, 'two', 'content'), 'utf8')).toBe('first')
})

it('shares one completed preparation between independent launcher processes', async () => {
  const module = new URL('../scripts/preparation-cache.ts', import.meta.url).href
  const script = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { prepareCachedDirectories } from ${JSON.stringify(module)};
    const root = process.argv[1];
    await prepareCachedDirectories({root, directories:['payload'], record:'ready.json', identity:()=> 'fixed',
      prepare:async stage=>{ mkdirSync(join(stage,'payload')); writeFileSync(join(stage,'payload','value'),'ready');
        writeFileSync(join(root,'writes'),'prepared\\n',{flag:'a'}); }});
  `
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script, root], {
    timeout: 60_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))),
  })
  const results = await Promise.allSettled([run(), run()])
  for (const result of results) expect(result.status, JSON.stringify(result)).toBe('fulfilled')
  expect(readFileSync(join(root, 'writes'), 'utf8')).toBe('prepared\n')
  expect(readFileSync(join(root, 'payload', 'value'), 'utf8')).toBe('ready')
})
