/** Touch model search typography keeps focus from enlarging the page. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/ModelSelect.module.css', import.meta.url), 'utf8')

describe('model search typography', () => {
  it('keeps compact desktop search and raises only coarse-pointer search to the touch minimum', () => {
    expect(css).toMatch(/\.searchRow \.search input\s*\{[^}]*font-size: 12px;/)
    const touchRule = css.match(/@media \(pointer: coarse\)\s*\{\s*\.searchRow \.search input\s*\{([^}]*)\}/)
    expect(touchRule?.[1]).toContain(
      'font-size: max(var(--dsw-font-base-16-font-size), var(--dsh-content-font-size, 14px));',
    )
  })
})
