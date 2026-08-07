import { handleAuth } from '@workos-inc/authkit-nextjs'

/**
 * WorkOS redirects here after authentication. The path must match
 * NEXT_PUBLIC_WORKOS_REDIRECT_URI and the Redirect URI configured in the
 * WorkOS dashboard exactly — a mismatch is the most common setup failure and
 * surfaces as an unhelpful error.
 */
export const GET = handleAuth({
  returnPathname: '/',
})
