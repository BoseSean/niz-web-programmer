import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * app.css is imported after the component styles, so a component rule that restyles one of its classes with a
 * single class of its own loses every property app.css also sets. [file, app.css class, component class]
 */
const RESTYLED: [string, string, string][] = [
  ['./library.css', 'btn', 'btn-danger'],
  ['./editors/editors.css', 'note', 'macro-confirm'],
]

describe('component CSS loaded before app.css', () => {
  it.each(RESTYLED)('%s scopes .%s.%s with both classes', (file, base, own) => {
    const text = css(file)
    expect(text).toContain(`.${base}.${own} {`)
    // no rule that starts with the component class alone (it would be outranked by .base)
    expect(text).not.toMatch(new RegExp(String.raw`(^|[},]\s*)\.${own}\b`, 'm'))
  })
})
