/** Reuse content-verified developer runtimes without repeating release smoke checks on every launch. */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePrimaryRuntime, type PreparePrimaryRuntimeOptions } from '../../../scripts/primary-runtime/prepare.ts'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { preparationFingerprint, prepareCachedDirectories } from './preparation-cache.ts'

/**
 * Reuse a fully checked Desktop runtime only while inputs and every output byte match.
 * @param options - Locked runtime target, version, build-owned resource directory and archive cache.
 * @returns Resolves after verification or staged preparation and native smoke checks. Failed preparation
 * preserves the old resources and cannot create a reusable cache record.
 */
export async function prepareDevelopmentRuntime(options: PreparePrimaryRuntimeOptions): Promise<void> {
  const require = createRequire(import.meta.url)
  const pnpm = dirname(require.resolve('pnpm'))
  const skills = options.skillSource ?? join(dirname(require.resolve('@deepseek-ai/dsh-skill-office/package.json')), 'assets')
  const inputs = [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./prepare-primary-runtime.ts', import.meta.url)),
    fileURLToPath(new URL('./preparation-cache.ts', import.meta.url)),
    fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)),
    fileURLToPath(new URL('../../../scripts/primary-runtime/lock.json', import.meta.url)),
    fileURLToPath(new URL('../../../scripts/primary-runtime/prepare.ts', import.meta.url)),
    fileURLToPath(new URL('../../../scripts/primary-runtime/prune-python-tests.ts', import.meta.url)),
    fileURLToPath(new URL('../../../scripts/primary-runtime/smoke.py', import.meta.url)),
    fileURLToPath(new URL('../../../packages/skill/tool-workspace-dependencies/src/index.ts', import.meta.url)),
    pnpm, skills,
  ]
  await prepareCachedDirectories({ root: options.output, directories: ['primary-runtime', 'office-skills'],
    record: '.development-preparation.json',
    identity: () => createHash('sha256').update(JSON.stringify({ target: options.target, version: options.version,
      pnpmArchive: options.pnpmArchive, pythonOnly: options.pythonOnly, inputs: preparationFingerprint(inputs, true),
      platform: process.platform, arch: process.arch,
    })).digest('hex'),
    prepare: async (staging) => {
      await preparePrimaryRuntime({ ...options, output: staging, skillSource: skills })
      smokePrimaryRuntime(join(staging, 'primary-runtime'))
    },
  })
}
