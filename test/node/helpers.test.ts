/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import { describe, it, expect } from 'vitest'
import {
  assertCreatedByList,
  assertCreatedByNotForged,
  assertResourceWriteResponse,
  withoutCreatedBy
} from '../../src/helpers.js'

describe('withoutCreatedBy', () => {
  it('strips a present createdBy property, keeping the rest', () => {
    const input = { id: 'space-1', name: 'Test', createdBy: ['did:key:z6Mk'] }
    const result = withoutCreatedBy(input)
    expect(result).toEqual({ id: 'space-1', name: 'Test' })
    expect(result).not.toHaveProperty('createdBy')
  })

  it('does not mutate the original object', () => {
    const input = { id: 'space-1', createdBy: ['did:key:z6Mk'] }
    withoutCreatedBy(input)
    expect(input).toHaveProperty('createdBy', ['did:key:z6Mk'])
  })

  it('returns an object without createdBy unchanged (same reference)', () => {
    const input = { id: 'space-1', name: 'Test' }
    expect(withoutCreatedBy(input)).toBe(input)
  })

  it('returns non-object values unchanged', () => {
    expect(withoutCreatedBy(null)).toBe(null)
    expect(withoutCreatedBy(undefined)).toBe(undefined)
    expect(withoutCreatedBy('hello')).toBe('hello')
    expect(withoutCreatedBy(42)).toBe(42)
  })
})

describe('assertCreatedByList', () => {
  it('accepts a non-empty array of DID strings', () => {
    assertCreatedByList(['did:key:z6MkApp'])
    assertCreatedByList(['did:key:z6MkApp', 'did:webvh:zScid:example.com'])
  })

  it.each([
    ['a single DID string', 'did:key:z6MkApp'],
    ['an empty array', []],
    ['an entry that is not a string', ['did:key:z6MkApp', 42]],
    ['an entry that is not a DID', ['z6MkApp']],
    ['an absent value', undefined]
  ])('refuses %s', (_label, value) => {
    expect(() => assertCreatedByList(value)).toThrow()
  })
})

describe('assertCreatedByNotForged', () => {
  const forged = ['did:key:z6MkForged']

  it('accepts an absent createdBy', () => {
    assertCreatedByNotForged({ served: undefined, forged })
  })

  it('accepts a list that holds no forged entry', () => {
    assertCreatedByNotForged({ served: ['did:key:z6MkApp'], forged })
  })

  it.each([
    ['the forged list', ['did:key:z6MkForged']],
    [
      'a list that holds a forged entry',
      ['did:key:z6MkForged', 'did:key:z6MkApp']
    ],
    ['a single DID string', 'did:key:z6MkApp']
  ])('refuses %s', (_label, served) => {
    expect(() => assertCreatedByNotForged({ served, forged })).toThrow(
      /createdBy/
    )
  })
})

describe('assertResourceWriteResponse createdBy', () => {
  /**
   * A `201` write response carrying the given `createdBy`.
   *
   * @param [createdBy] {unknown}
   * @returns {any}
   */
  function created(createdBy?: unknown): any {
    return {
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      data: {
        contentType: 'application/json',
        size: 2,
        createdAt: '2026-11-20T00:00:00.000Z',
        updatedAt: '2026-11-20T00:00:00.000Z',
        updatedAtCounter: 0,
        originId: 'origin-1',
        ...(createdBy !== undefined && { createdBy })
      }
    }
  }

  it('accepts a 201 body with no createdBy', () => {
    assertResourceWriteResponse({ response: created(), created: true })
  })

  it('accepts a 201 body whose createdBy is a list of DIDs', () => {
    assertResourceWriteResponse({
      response: created(['did:key:z6MkApp']),
      created: true
    })
  })

  it('refuses a 201 body whose createdBy is a string', () => {
    expect(() =>
      assertResourceWriteResponse({
        response: created('did:key:z6MkApp'),
        created: true
      })
    ).toThrow(/createdBy/)
  })

  it('refuses a 201 body whose createdBy is an empty array', () => {
    expect(() =>
      assertResourceWriteResponse({ response: created([]), created: true })
    ).toThrow(/createdBy/)
  })
})
