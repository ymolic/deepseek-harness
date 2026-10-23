/** Desktop carriers keep a complete interpreter payload even when SDK carriers choose Python-only. */

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { preparePrimaryRuntime, smokePrimaryRuntime } from '../scripts/prepare-primary-runtime.ts'

const state = vi.hoisted(() => ({ runtime: '', prepare: vi.fn() }))
vi.mock('../scripts/desktop-build-paths.mjs', async original => ({
  ...await original<typeof import('../scripts/desktop-build-paths.mjs')>(),
  resolveDesktopTargetBuildPaths: () => ({ runtime: state.runtime, downloads: join(state.runtime, 'downloads') }),
}))
vi.mock('../../../scripts/primary-runtime/prepare.ts', async original => ({
  ...await original<typeof import('../../../scripts/primary-runtime/prepare.ts')>(),
  preparePrimaryRuntime: state.prepare,
}))

it('rejects a Python-only native Desktop payload before executing interpreters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-python-only-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      python: '3.12.14', pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
    }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('Desktop payload must declare node and pnpm')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('invalidates previous development success before explicit preparation (failure=%s)', async (failure) => {
  state.runtime = await mkdtemp(join(tmpdir(), 'desktop-explicit-preparation-'))
  state.prepare.mockReset()
  if (failure) state.prepare.mockRejectedValue(new Error('preparation failed'))
  const record = join(state.runtime, '.development-preparation.json')
  try {
    await writeFile(record, 'old success')
    if (failure) await expect(preparePrimaryRuntime({ deferSmoke: true })).rejects.toThrow('preparation failed')
    else await preparePrimaryRuntime({ deferSmoke: true })
    await expect(access(record)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(`${record}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(state.runtime, { recursive: true, force: true }) }
})
