/** Runtime reuse keeps full smoke checks on preparation and repairs content changes. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PreparePrimaryRuntimeOptions } from '../../../scripts/primary-runtime/prepare.ts'

const state = vi.hoisted(() => ({ prepare: vi.fn(), smoke: vi.fn() }))
vi.mock('../../../scripts/primary-runtime/prepare.ts', async original => ({
  ...await original<typeof import('../../../scripts/primary-runtime/prepare.ts')>(),
  preparePrimaryRuntime: state.prepare,
}))
vi.mock('../scripts/prepare-primary-runtime.ts', () => ({ smokePrimaryRuntime: state.smoke }))
import { prepareDevelopmentRuntime } from '../scripts/development-runtime.ts'

let root: string
let options: PreparePrimaryRuntimeOptions
beforeEach(() => {
  vi.resetAllMocks()
  root = mkdtempSync(join(tmpdir(), 'dsh-development-runtime-'))
  const skills = join(root, 'skills')
  mkdirSync(skills)
  writeFileSync(join(skills, 'SKILL.md'), 'office skills')
  options = { output: join(root, 'runtime'), cache: join(root, 'archives'), version: '1.2.3', target: 'win-x64', skillSource: skills }
  state.prepare.mockImplementation(async (input: PreparePrimaryRuntimeOptions) => {
    const payload = join(input.output, 'primary-runtime')
    mkdirSync(payload, { recursive: true })
    writeFileSync(join(payload, 'runtime.json'), JSON.stringify({ version: input.version, target: input.target }))
    writeFileSync(join(payload, 'python.exe'), 'interpreter')
    cpSync(input.skillSource!, join(input.output, 'office-skills'), { recursive: true, dereference: true })
  })
})
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

it('prepares and fully checks once, then reuses the byte-checked runtime offline', async () => {
  await prepareDevelopmentRuntime(options)
  state.prepare.mockRejectedValue(new Error('network unavailable'))
  await prepareDevelopmentRuntime(options)
  expect(state.prepare).toHaveBeenCalledTimes(1)
  expect(state.smoke).toHaveBeenCalledTimes(1)
  expect(state.smoke.mock.calls[0]![0]).toContain('.preparing-')
  expect(readFileSync(join(options.output, 'primary-runtime', 'python.exe'), 'utf8')).toBe('interpreter')
})

it.each(['version', 'target', 'skills', 'missing', 'corrupt'] as const)('prepares and checks again after %s changes', async (change) => {
  await prepareDevelopmentRuntime(options)
  if (change === 'version') options = { ...options, version: '2.0.0' }
  else if (change === 'target') options = { ...options, target: 'mac-arm64' }
  else if (change === 'skills') writeFileSync(join(options.skillSource!, 'SKILL.md'), 'updated skills')
  else if (change === 'missing') rmSync(join(options.output, 'primary-runtime', 'python.exe'))
  else writeFileSync(join(options.output, 'primary-runtime', 'python.exe'), 'CORRUPTION!')
  await prepareDevelopmentRuntime(options)
  await prepareDevelopmentRuntime(options)
  expect(state.prepare).toHaveBeenCalledTimes(2)
  expect(state.smoke).toHaveBeenCalledTimes(2)
})

it('does not replace a working runtime or cache failed smoke checks', async () => {
  await prepareDevelopmentRuntime(options)
  options = { ...options, version: '2.0.0' }
  state.smoke.mockImplementationOnce(() => { throw new Error('Office round trip failed') })
  await expect(prepareDevelopmentRuntime(options)).rejects.toThrow('Office round trip failed')
  expect(JSON.parse(readFileSync(join(options.output, 'primary-runtime', 'runtime.json'), 'utf8'))).toMatchObject({ version: '1.2.3' })
  await prepareDevelopmentRuntime(options)
  expect(state.smoke).toHaveBeenCalledTimes(3)
  expect(JSON.parse(readFileSync(join(options.output, 'primary-runtime', 'runtime.json'), 'utf8'))).toMatchObject({ version: '2.0.0' })
})

it('invalidates resources when a linked Office source changes without retargeting the link', async () => {
  const target = join(root, 'linked-assets')
  mkdirSync(target)
  writeFileSync(join(target, 'guide.md'), 'original guide')
  symlinkSync(target, join(options.skillSource!, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await prepareDevelopmentRuntime(options)
  writeFileSync(join(target, 'guide.md'), 'modified guide')
  await prepareDevelopmentRuntime(options)
  expect(state.prepare).toHaveBeenCalledTimes(2)
  expect(readFileSync(join(options.output, 'office-skills/linked/guide.md'), 'utf8')).toBe('modified guide')
})
