/** Prepare the disposable npm-project view used by an unpackaged Electron shell. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevelopmentProjectMetadata } from '../src/project-manager.ts'
import type { DesktopRelease } from '../src/release.ts'
import { DESKTOP_RUNTIME_FILE, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import type { DesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'
import { desktopTargetPlatform } from './desktop-build-paths.mjs'
import { preparationFingerprint, prepareCachedDirectories } from './preparation-cache.ts'

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
}

/** Inputs whose locations differ between the launcher and isolated tests. */
export interface DevelopmentProjectOptions {
  /** Build-owned directory reused while its complete dependency projection matches. */
  readonly projectDir: string
  /** Current workspace's `apps/cli` package directory. */
  readonly cliDir: string
  /** Current workspace's private Desktop Host application directory. */
  readonly hostDir: string
  /** pnpm's workspace-wide virtual-hoist directory. */
  readonly dependencyDir: string
  /** Release identity written into the disposable project metadata. */
  readonly release: DesktopRelease
  /** Build target whose prepared payload the disposable project runs against. */
  readonly target: DesktopAutoUpdateTarget
  /** Workspace lockfile; omission identifies the projection by its resolved dependency graph alone. */
  readonly lockfile?: string
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function linkDirectory(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function dependencyLinks(sourceRoot: string): Map<string, string> {
  const links = new Map<string, string>()
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const source = join(sourceRoot, entry.name)
    if (entry.name.startsWith('@') && (entry.isDirectory() || entry.isSymbolicLink())) {
      for (const scoped of readdirSync(source, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        links.set(`${entry.name}/${scoped.name}`, realpathSync.native(join(source, scoped.name)))
      }
      continue
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      links.set(entry.name, realpathSync.native(source))
    }
  }
  return links
}

/** Configured workspace plugins must resolve from the profile even when pnpm does not hoist them. */
function workspaceDependencies(roots: readonly string[], links: Map<string, string>): void {
  const visited = new Set<string>()
  const visit = (directory: string): void => {
    const source = realpathSync.native(directory)
    if (visited.has(source)) return
    visited.add(source)
    const manifest = readManifest(join(source, 'package.json'))
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      if (!specifier.startsWith('workspace:')) continue
      const dependency = join(source, 'node_modules', ...name.split('/'))
      if (!existsSync(dependency)) {
        throw new Error(`desktop development: ${name} is missing from ${source}; run pnpm install`)
      }
      links.set(name, realpathSync.native(dependency))
      visit(dependency)
    }
  }
  for (const directory of roots) visit(directory)
}

function validateSource(options: DevelopmentProjectOptions): void {
  const cliManifest = readManifest(join(options.cliDir, 'package.json'))
  if (cliManifest.name !== '@deepseek-ai/dsh' || cliManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/cli must be @deepseek-ai/dsh@${options.release.version}, found `
      + `${String(cliManifest.name)}@${String(cliManifest.version)}`,
    )
  }
  if (!existsSync(options.dependencyDir)) {
    throw new Error('desktop development: workspace dependency links are missing; run pnpm install')
  }
  const hostManifest = readManifest(join(options.hostDir, 'package.json'))
  if (hostManifest.name !== '@deepseek-ai/dsh-desktop-host' || hostManifest.version !== options.release.version) {
    throw new Error(
      `desktop development: apps/desktop-host must be @deepseek-ai/dsh-desktop-host@${options.release.version}, found `
      + `${String(hostManifest.name)}@${String(hostManifest.version)}`,
    )
  }
  if (!existsSync(join(options.hostDir, 'lib', 'index.js'))) {
    throw new Error('desktop development: apps/desktop-host/lib/index.js is missing; run pnpm run build')
  }
}

/**
 * Reuse a complete dependency projection or replace it with links to the current built workspace.
 * @param options - Project destination, CLI package, release identity, and build target.
 * @returns The project directory after graph, lockfile, release and output verification.
 * Missing source dependencies reject without modifying the existing projection.
 */
export async function prepareDevelopmentProject(options: DevelopmentProjectOptions): Promise<string> {
  const plan = () => {
    validateSource(options)
    const links = dependencyLinks(options.dependencyDir)
    workspaceDependencies([options.cliDir, options.hostDir], links)
    links.set('@deepseek-ai/dsh', realpathSync.native(options.cliDir))
    links.set('@deepseek-ai/dsh-desktop-host', realpathSync.native(options.hostDir))
    const entries = [...links].sort(([left], [right]) => left.localeCompare(right))
    const manifests = entries.map(([name, source]) => ({ name, source, manifest: readManifest(join(source, 'package.json')) }))
    const identity = createHash('sha256').update(JSON.stringify({ release: options.release, target: options.target,
      manifests: manifests.map(({ name, source, manifest }) => [name, source, manifest.name, manifest.version,
        Object.entries(manifest.dependencies ?? {}).sort(([left], [right]) => left.localeCompare(right))]),
      implementation: preparationFingerprint([fileURLToPath(import.meta.url), fileURLToPath(new URL('../src/project-manager.ts', import.meta.url)),
        fileURLToPath(new URL('./preparation-cache.ts', import.meta.url))]),
      lockfile: options.lockfile === undefined ? undefined : readFileSync(options.lockfile, 'utf8'),
    })).digest('hex')
    const sharedPackages = manifests.flatMap(({ name, manifest }) => {
      return typeof manifest.version === 'string' ? [{ name, version: manifest.version, path: `node_modules/${name}` }] : []
    })
    const runtime: DesktopRuntimeDescriptor = { schemaVersion: 1, release: options.release,
      ...desktopTargetPlatform(options.target), sharedPackages, files: [] }
    return { links, identity, runtime }
  }
  const name = basename(options.projectDir)
  await prepareCachedDirectories({ root: dirname(options.projectDir), directories: [name], record: `.${name}-preparation.json`,
    identity: () => plan().identity,
    prepare: async (staging) => {
      const project = join(staging, name)
      const { links, runtime } = plan()
      createDevelopmentProjectMetadata(project, options.release)
      for (const [dependency, source] of links) linkDirectory(source, join(project, 'node_modules', dependency))
      writeFileSync(join(project, DESKTOP_RUNTIME_FILE), `${JSON.stringify(runtime, undefined, 2)}\n`)
    },
  })
  return options.projectDir
}
