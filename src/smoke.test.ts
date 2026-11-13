import { describe, expect, it } from 'vitest'
import { emptyTable } from './protocol/slots'

describe('project setup', () => {
  it('creates an empty 2 x 84 slot table', () => {
    const t = emptyTable()
    expect(t.base).toHaveLength(84)
    expect(t.fn).toHaveLength(84)
  })
})
