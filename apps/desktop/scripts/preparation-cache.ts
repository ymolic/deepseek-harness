/** Content-checked reuse and staged replacement of development-only resources. */

import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync,
  renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/**
 * Hash resource bytes, directory entries, permissions and either link targets or their copied contents.
 * @param paths - Ordered resource roots; a missing or unreadable input throws.
 * @param dereference - Follow source links when the producer copies their contents; omitted records link targets only.
 * @returns SHA-256 identity independent of timestamps and directory enumeration order.
 */
export function preparationFingerprint(paths: readonly string[], dereference = false): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const ancestors = new Set<string>()
  const visit = (path: string, name: string): void => {
    const info = lstatSync(path)
    if (info.isSymbolicLink() && dereference) {
      visit(realpathSync.native(path), name)
      return
    }
    hash.update(JSON.stringify([name, info.mode, info.isFile() ? info.size : null,
      info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'file']))
    if (info.isSymbolicLink()) hash.update(JSON.stringify(readlinkSync(path)))
    else if (info.isDirectory()) {
      const canonical = dereference ? realpathSync.native(path) : path
      if (ancestors.has(canonical)) throw new Error(`desktop preparation: cyclic resource directory at ${path}`)
      ancestors.add(canonical)
      try {
        for (const entry of readdirSync(path).sort()) visit(join(path, entry), `${name}/${entry}`)
      } finally { ancestors.delete(canonical) }
    } else if (info.isFile()) {
      const file = openSync(path, 'r')
      try {
        let length: number
        while ((length = readSync(file, buffer)) !== 0) hash.update(buffer.subarray(0, length))
      } finally { closeSync(file) }
    } else throw new Error(`desktop preparation: unsupported resource at ${path}`)
  }
  paths.forEach((path, index) => { visit(path, String(index)) })
  return hash.digest('hex')
}

/**
 * Read a disposable cache record; malformed or absent records require preparation.
 * @param path - Cache record path.
 * @returns Parsed record, or undefined for missing or invalid JSON; other I/O failures throw.
 */
function readPreparationRecord(path: string): unknown {
  let content: string
  try { content = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try { return JSON.parse(content) } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function matches(record: unknown, identity: string, paths: readonly string[]): boolean {
  if (record === null || typeof record !== 'object' || !('schemaVersion' in record) || record.schemaVersion !== 1
    || !('identity' in record) || record.identity !== identity || !('output' in record) || typeof record.output !== 'string') return false
  try { return record.output === preparationFingerprint(paths) } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

/** Development resource preparation with a cross-process writer lock. */
export interface CachedPreparation {
  /** Existing or new build-owned parent directory. */
  readonly root: string
  /** Plain directory names replaced together; no user data may live here. */
  readonly directories: readonly string[]
  /** Stable cache filename, separate from the replaced resources. */
  readonly record: string
  /** Fingerprint of all preparation inputs, rechecked before publication. */
  readonly identity: () => string
  /** Populate the named directories beneath this private staging directory; reject before publication on failure. */
  readonly prepare: (staging: string) => Promise<void>
}

/**
 * Reuse matching complete resources or prepare and publish replacements under one writer lock.
 * @param options - Build-owned locations, input identity and preparation operation.
 * @returns Resolves after reuse or complete publication. Preparation failures preserve old resources;
 * publication failures attempt restoration and reject, including restoration errors when recovery fails.
 */
export async function prepareCachedDirectories(options: CachedPreparation): Promise<void> {
  mkdirSync(options.root, { recursive: true })
  const recordPath = join(options.root, options.record)
  await withFileLock(recordPath, async () => {
    const identity = options.identity()
    const destinations = options.directories.map(name => join(options.root, name))
    if (matches(readPreparationRecord(recordPath), identity, destinations)) return
    const staging = mkdtempSync(join(options.root, '.preparing-'))
    const previous: string[] = []
    const published: string[] = []
    let retainStaging = false
    try {
      await options.prepare(staging)
      if (options.identity() !== identity) throw new Error('desktop preparation: inputs changed during preparation; retry the launcher')
      const output = preparationFingerprint(options.directories.map(name => join(staging, name)))
      try {
        for (const name of options.directories) {
          const destination = join(options.root, name)
          try { renameSync(destination, join(staging, `.previous-${name}`)); previous.push(name) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          renameSync(join(staging, name), destination)
          published.push(name)
        }
        await writeFileAtomic(recordPath, `${JSON.stringify({ schemaVersion: 1, identity, output })}\n`, { mode: 0o600 })
      } catch (error) {
        try {
          for (const name of published.reverse()) renameSync(join(options.root, name), join(staging, name))
          for (const name of previous.reverse()) renameSync(join(staging, `.previous-${name}`), join(options.root, name))
        } catch (restoreError) {
          retainStaging = true
          throw new AggregateError([error, restoreError], `desktop preparation: replacement and restoration failed; recover resources from ${staging}`)
        }
        throw error
      }
    } finally {
      if (!retainStaging) rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, { waitMs: 600_000 })
}
