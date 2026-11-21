/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
import type { Suite } from '../harness/types.js'

import { authzOrderingApi } from './authz-ordering-api.js'
import { blindedIndexApi } from './blinded-index-api.js'
import { changesQueryApi } from './changes-query-api.js'
import { chunksApi } from './chunks-api.js'
import { clientBackends } from './client-backends.js'
import { clientDelegation } from './client-delegation.js'
import { clientExportImport } from './client-export-import.js'
import { clientResources } from './client-resources.js'
import { clientSpaces } from './client-spaces.js'
import { collectionApi } from './collection-api.js'
import { conditionalRequestsApi } from './conditional-requests-api.js'
import { containerRuleApi } from './container-rule-api.js'
import { createdByApi } from './created-by-api.js'
import { delegationCryptosuitesApi } from './delegation-cryptosuites-api.js'
import { denialReasonsApi } from './denial-reasons-api.js'
import { digestApi } from './digest-api.js'
import { encryptionDescriptorApi } from './encryption-descriptor-api.js'
import { governedLogApi } from './governed-log-api.js'
import { invocationTargetApi } from './invocation-target-api.js'
import { plaintextDeclarationApi } from './plaintext-declaration-api.js'
import { policyApi } from './policy-api.js'
import { reservedMethodsApi } from './reserved-methods-api.js'
import { resourceApi } from './resource-api.js'
import { serviceDescriptionApi } from './service-description-api.js'
import { server } from './server.js'
import { spacesApi } from './spaces-api.js'
import { writeStampApi } from './write-stamp-api.js'
import { writeValidationApi } from './write-validation-api.js'
import { writerAttributionApi } from './writer-attribution-api.js'

/**
 * The full conformance registry, in canonical run order (matching the
 * original file-alphabetical execution order of the ported suite).
 */
export const suites: Array<Suite<any>> = [
  authzOrderingApi,
  blindedIndexApi,
  changesQueryApi,
  chunksApi,
  clientBackends,
  clientDelegation,
  clientExportImport,
  clientResources,
  clientSpaces,
  collectionApi,
  conditionalRequestsApi,
  containerRuleApi,
  createdByApi,
  delegationCryptosuitesApi,
  denialReasonsApi,
  digestApi,
  encryptionDescriptorApi,
  governedLogApi,
  invocationTargetApi,
  plaintextDeclarationApi,
  policyApi,
  reservedMethodsApi,
  resourceApi,
  serviceDescriptionApi,
  server,
  spacesApi,
  writeStampApi,
  writeValidationApi,
  writerAttributionApi
]

export {
  authzOrderingApi,
  blindedIndexApi,
  changesQueryApi,
  chunksApi,
  clientBackends,
  clientDelegation,
  clientExportImport,
  clientResources,
  clientSpaces,
  collectionApi,
  conditionalRequestsApi,
  containerRuleApi,
  createdByApi,
  delegationCryptosuitesApi,
  denialReasonsApi,
  digestApi,
  encryptionDescriptorApi,
  governedLogApi,
  invocationTargetApi,
  plaintextDeclarationApi,
  policyApi,
  reservedMethodsApi,
  resourceApi,
  serviceDescriptionApi,
  server,
  spacesApi,
  writeStampApi,
  writeValidationApi,
  writerAttributionApi
}
