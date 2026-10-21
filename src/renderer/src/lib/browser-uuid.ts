// Renderer-facing name for the shared generator. A re-export, so renderer code keeps one
// obvious import and src/shared keeps the single implementation.
export { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/non-secure-context-uuid'
