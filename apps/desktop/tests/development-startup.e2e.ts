/** Built Host startup after dependency-projection reuse, with a private home and no provider requests. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const version = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version

it.skipIf(!existsSync(join(repository, 'apps/desktop-host/lib/index.js')))(
  'boots the built Desktop Host from an unchanged cached dependency projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cached-host-'))
    let host: DesktopHostProcess | undefined
    try {
      const options = {
        projectDir: join(root, 'project'), cliDir: join(repository, 'apps/cli'), hostDir: join(repository, 'apps/desktop-host'),
        dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'), lockfile: join(repository, 'pnpm-lock.yaml'),
        release: { schemaVersion: 1 as const, version: version(join(repository, 'apps/desktop/package.json')),
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: process.versions.node,
          pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')) },
        target: 'win-x64' as const,
      }
      const project = await prepareDevelopmentProject(options)
      const before = statSync(join(project, 'desktop-runtime.json')).birthtimeMs
      await prepareDevelopmentProject(options)
      expect(statSync(join(project, 'desktop-runtime.json')).birthtimeMs).toBe(before)

      const runtime = join(root, 'runtime')
      cpSync(join(repository, 'packages/skill/skill-office/assets'), join(runtime, 'office-skills'), { recursive: true })
      const nodeBin = join(runtime, 'primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      const home = join(root, 'home')
      const paths = resolveDesktopPaths(home)
      await new DesktopProjectManager(paths, { dsh: project }).applyRelease()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
      host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined,
        { ...environment, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' })
      const ready = await host.start()
      const authentication = await fetch(ready.url, { redirect: 'manual' })
      expect(authentication.status).toBe(303)
      const cookie = authentication.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      await authentication.body?.cancel()
      const response = await fetch(new URL('/', ready.url), { headers: { cookie } })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('id="root"')
    } finally {
      await host?.stop()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
)
