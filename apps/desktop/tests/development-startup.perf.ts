/** Threshold-free development preparation timings; no Electron, profile, model or user data is opened. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { prepareDevelopmentRuntime } from '../scripts/development-runtime.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const root = mkdtempSync(join(tmpdir(), 'dsh-development-perf-'))
const version = (JSON.parse(readFileSync(join(repository, 'apps/desktop/package.json'), 'utf8')) as { version: string }).version
const pnpmVersion = (JSON.parse(readFileSync(join(repository, 'node_modules/pnpm/package.json'), 'utf8')) as { version: string }).version

async function measure(phase: string, operation: () => Promise<unknown>): Promise<void> {
  const samplesMs: number[] = []
  for (let sample = 0; sample < 3; sample++) {
    const start = performance.now()
    await operation()
    samplesMs.push(Math.round(performance.now() - start))
  }
  global.gc?.()
  console.log(JSON.stringify({ phase, samplesMs, memory: process.memoryUsage(), peakRssKiB: process.resourceUsage().maxRSS }))
}

try {
  await measure('project-first-and-reuse', () => prepareDevelopmentProject({
    projectDir: join(root, 'project'), cliDir: join(repository, 'apps/cli'), hostDir: join(repository, 'apps/desktop-host'),
    dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'), lockfile: join(repository, 'pnpm-lock.yaml'),
    release: { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: process.versions.node, pnpmVersion },
    target: resolveDesktopBuildTarget(),
  }))
  if (!process.argv.includes('--project-only')) {
    await measure('runtime-first-and-reuse', () => prepareDevelopmentRuntime({
      target: resolveDesktopBuildTarget(), version, output: join(root, 'runtime'), cache: resolveDesktopTargetBuildPaths().downloads,
    }))
  }
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
