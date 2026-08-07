import { authkitProxy } from '@workos-inc/authkit-nextjs'

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy`. AuthKit
 * tracks the same rename — `authkitMiddleware` is deprecated in favour of
 * `authkitProxy` — so both halves use the current name.
 *
 * IMPORTANT: this is not the security boundary.
 *
 * The Next docs are explicit that proxy is for "optimistic checks" and
 * "should not be used as a full session management or authorization solution".
 * It runs before rendering and may be deployed to a CDN, so it gives a fast
 * redirect for signed-out visitors — nothing more. Every protected route
 * handler and server component independently verifies the session through
 * `requireUser()` in src/lib/auth.ts. Deleting this file must not make any
 * protected data reachable.
 */
export default authkitProxy({
  middlewareAuth: {
    enabled: true,
    // Everything is gated. The sign-in flow itself must stay reachable while
    // signed out, or the redirect would loop.
    unauthenticatedPaths: ['/callback', '/sign-in', '/sign-up'],
  },
})

export const config = {
  /*
   * Skip Next internals and static assets. Matching them would run session
   * logic on every image request for no benefit.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
