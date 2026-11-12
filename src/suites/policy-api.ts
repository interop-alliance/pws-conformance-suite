/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * WAS conformance tests -- Access-control policy (public-read fallback).
 */
import {
  collectionLinksetUrl,
  collectionPolicyUrl,
  resourcePolicyUrl,
  resourceUrl as resourceUrlOf,
  spacePolicyUrl,
  spaceUrlById
} from '@interop/pws-client/paths'
import assert from '../harness/assert.js'
import { serviceFeatures } from '../harness/serviceDescription.js'
import type { Suite } from '../harness/types.js'

interface State {
  alice: any
  bob: any
  collectionId: string
  resourceId: string
  resourceUrl: () => string
  policyUrl: () => string
}

export const policyApi: Suite<State> = {
  id: 'policy-api',
  name: 'Access-control policy API',

  setup: async ctx => {
    const alice: any = { ...ctx.actors.alice }
    const bob: any = { ...ctx.actors.bob }

    const collectionId = 'public-credentials'
    const resourceId = 'public-vc'
    const resourceUrl = () =>
      resourceUrlOf({ spaceUrl: alice.space1.url, collectionId, resourceId })
    const policyUrl = () =>
      collectionPolicyUrl({ spaceUrl: alice.space1.url, collectionId })

    const spaceId = ctx.generateId()
    alice.space1 = {
      id: spaceId,
      url: spaceUrlById({ baseServerUrl: ctx.serverUrl, spaceId })
    }
    await ctx.createSpace({
      spaceDescription: {
        id: alice.space1.id,
        name: "Alice's Space #1",
        controller: alice.did
      },
      rootClient: alice.rootClient
    })
    await alice.rootClient.request({
      url: alice.space1.url,
      method: 'POST',
      json: { id: collectionId, name: 'Public Credentials' }
    })
    await alice.rootClient.request({
      url: resourceUrl(),
      method: 'PUT',
      json: { id: resourceId, name: 'A shared Verifiable Credential' }
    })

    return { alice, bob, collectionId, resourceId, resourceUrl, policyUrl }
  },

  teardown: async (ctx, state) => {
    const { alice } = state
    try {
      await alice.rootClient.request({
        url: alice.space1.url,
        method: 'DELETE'
      })
    } catch {
      /* best-effort cleanup */
    }
  },

  tests: [
    {
      id: 'policy.anonymous-no-policy-404',
      name: 'anonymous GET of a resource with no policy is denied (404)',
      specRefs: ['https://w3id.org/pws#access-control-policies'],
      run: async (ctx, state) => {
        const { resourceUrl } = state
        const response = await fetch(resourceUrl())
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'policy.put-collection-public-201',
      name: '[controller] PUT a PublicCanRead policy on the collection (201)',
      specRefs: [
        'https://w3id.org/pws#access-control-policies',
        'https://w3id.org/pws/authz-profile#publiccanread',
        'https://w3id.org/pws/authz-profile#policy-type-registry'
      ],
      run: async (ctx, state) => {
        const { alice, policyUrl } = state
        const response = await alice.rootClient.request({
          url: policyUrl(),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })
        assert.equal(response.status, 201)
      }
    },
    {
      id: 'policy.anonymous-public-read-200',
      name: 'anonymous GET of a resource in a PublicCanRead collection succeeds (200)',
      specRefs: [
        'https://w3id.org/pws#access-control-policies',
        'https://w3id.org/pws/authz-profile#publiccanread',
        'https://w3id.org/pws/authz-profile#policy-type-registry'
      ],
      run: async (ctx, state) => {
        const { resourceUrl } = state
        const response = await fetch(resourceUrl())
        assert.equal(response.status, 200)
        const body = (await response.json()) as { name: string }
        assert.equal(body.name, 'A shared Verifiable Credential')
      }
    },
    {
      id: 'policy.unauthorized-falls-back-200',
      name: 'a caller whose capability does not authorize falls back to policy (200)',
      specRefs: ['https://w3id.org/pws#access-control-policies'],
      run: async (ctx, state) => {
        const { bob, resourceUrl } = state
        // Bob is not the Space controller, so the root capability he invokes
        // does not authorize the read. The policy is consulted as the
        // fallback, and PublicCanRead grants the read.
        const response = await bob.rootClient.request({
          url: resourceUrl(),
          method: 'GET'
        })
        assert.equal(response.status, 200)
      }
    },
    {
      id: 'policy.anonymous-write-rejected-404',
      name: 'anonymous write is still rejected (404, masked) on a public collection',
      specRefs: [
        'https://w3id.org/pws#error-handling',
        'https://w3id.org/pws#access-control-policies',
        'https://w3id.org/pws/authz-profile#publiccanread',
        'https://w3id.org/pws/authz-profile#policy-type-registry'
      ],
      run: async (ctx, state) => {
        const { resourceUrl } = state
        // PublicCanRead grants reads only. A request with no authorization
        // that lacks privilege for an existing target is reported as
        // not-found (404), the same as an absent target. The id keeps its
        // historical `-401` suffix.
        const response = await fetch(resourceUrl(), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'anon write' })
        })
        assert.equal(response.status, 404)
        // The refused write changed nothing.
        const reread = await fetch(resourceUrl())
        assert.equal(reread.status, 200)
        const body = (await reread.json()) as { name: string }
        assert.equal(body.name, 'A shared Verifiable Credential')
      }
    },
    {
      id: 'policy.linkset-advertises-policy',
      name: 'the collection linkset advertises the policy resource',
      specRefs: [
        'https://w3id.org/pws#collection-linkset',
        'https://w3id.org/pws#access-control-policies'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId } = state
        // Linksets are an OPTIONAL extension, advertised by the `linksets`
        // feature token.
        const features = await serviceFeatures({ serverUrl: ctx.serverUrl })
        if (!features.includes('linksets')) {
          ctx.skip('the server does not advertise linksets')
        }
        const linksetUrl = collectionLinksetUrl({
          spaceUrl: alice.space1.url,
          collectionId
        })
        const response = await fetch(linksetUrl)
        assert.equal(response.status, 200)
        assert.match(
          response.headers.get('content-type')!,
          /application\/linkset\+json/
        )
        const body = (await response.json()) as {
          linkset: Array<Record<string, any>>
        }
        // An `href` is a URL the server names, absolute or relative. It is
        // compared after resolving it against the linkset's own URL.
        const href = body.linkset[0]!['https://w3id.org/pws#policy'][0].href
        assert.equal(
          new URL(href, linksetUrl).toString(),
          collectionPolicyUrl({ spaceUrl: alice.space1.url, collectionId })
        )
      }
    },
    {
      id: 'policy.delete-revokes-404',
      name: '[controller] DELETE the policy revokes public access (404)',
      specRefs: ['https://w3id.org/pws#access-control-policies'],
      run: async (ctx, state) => {
        const { alice, policyUrl, resourceUrl } = state
        const del = await alice.rootClient.request({
          url: policyUrl(),
          method: 'DELETE'
        })
        assert.equal(del.status, 204)

        const response = await fetch(resourceUrl())
        assert.equal(response.status, 404)
      }
    },
    {
      id: 'policy.resource-level-grant',
      name: 'a resource-level policy grants public read on a single resource',
      specRefs: [
        'https://w3id.org/pws#access-control-policies',
        'https://w3id.org/pws/authz-profile#publiccanread',
        'https://w3id.org/pws/authz-profile#policy-type-registry'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId, resourceId, resourceUrl } = state
        // The collection policy was just removed, so this isolates resource-level.
        await alice.rootClient.request({
          url: resourcePolicyUrl({
            spaceUrl: alice.space1.url,
            collectionId,
            resourceId
          }),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })
        const response = await fetch(resourceUrl())
        assert.equal(response.status, 200)

        // Clean up so it does not mask the space-level inheritance check below.
        await alice.rootClient.request({
          url: resourcePolicyUrl({
            spaceUrl: alice.space1.url,
            collectionId,
            resourceId
          }),
          method: 'DELETE'
        })
        assert.equal((await fetch(resourceUrl())).status, 404)
      }
    },
    {
      id: 'policy.space-level-inherited',
      name: 'a space-level policy is inherited by resources',
      specRefs: [
        'https://w3id.org/pws#access-control-policies',
        'https://w3id.org/pws/authz-profile#publiccanread',
        'https://w3id.org/pws/authz-profile#policy-type-registry'
      ],
      run: async (ctx, state) => {
        const { alice, collectionId } = state
        // A second resource with no policy of its own.
        const inheritedUrl = resourceUrlOf({
          spaceUrl: alice.space1.url,
          collectionId,
          resourceId: 'inherited-vc'
        })
        await alice.rootClient.request({
          url: inheritedUrl,
          method: 'PUT',
          json: { id: 'inherited-vc', name: 'Inherited' }
        })
        assert.equal((await fetch(inheritedUrl)).status, 404)

        // A space-level PublicCanRead policy makes it readable by inheritance.
        await alice.rootClient.request({
          url: spacePolicyUrl({ spaceUrl: alice.space1.url }),
          method: 'PUT',
          json: { type: 'PublicCanRead' }
        })
        assert.equal((await fetch(inheritedUrl)).status, 200)
      }
    }
  ]
}
