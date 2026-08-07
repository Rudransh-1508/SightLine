import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Mirror the "@/*" alias from tsconfig so tests import the same way the app does.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // The suite is pure data and logic — no DOM, so the default node
    // environment keeps it fast enough to run on every save.
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    /*
     * Several test files spin up their own in-process Postgres (PGlite, WASM)
     * and replay the full migration into it — see src/db/__tests__/helpers.ts.
     * Vitest runs test files in parallel across CPU cores by default; with
     * 10+ DB-backed files that means that many WASM Postgres instances
     * starting concurrently, which repeatedly caused false failures on this
     * machine — not from the code under test, but from the test runner
     * itself starving under contention:
     *   - raising hookTimeout to 30s alone was insufficient
     *   - capping maxThreads to 4 was ALSO insufficient — the same
     *     "[vitest-worker]: Timeout calling onTaskUpdate" failures recurred
     *   - fully serialising file execution (below) has been the only setting
     *     that ran the whole 255-test suite reliably, twice in a row, ~167s
     * The available headroom on this machine appears to vary rather than
     * being a fixed number to tune a thread cap around, so serialising is the
     * deterministic choice rather than continuing to guess at a count.
     * Individual files still finish in milliseconds to low seconds; the
     * total is a few minutes, which is an acceptable trade for a suite that
     * actually passes every time rather than failing ~15% of the time on
     * infrastructure noise.
     */
    hookTimeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/**/__tests__/**', 'src/lib/types.ts'],
      reporter: ['text', 'lcov'],
    },
  },
})
