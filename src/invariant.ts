/**
 * Package-owned invariant companion for `dsh-ssh`.
 * @module dsh-ssh/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = 'dsh-ssh'

/** Cordis companion plugin name. */
export const name = 'dsh-ssh-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The slice of the host invariant service this companion uses. Declared
 * structurally so the package does not need a hard dependency on
 * `@deepseek-ai/dsh-invariants`, whose peer range still pins the previous
 * cordis major.
 */
interface InvariantService {
  register(packageName: string, install: () => void): () => void
}

/**
 * No runtime invariant: connection, process, and terminal teardown have one
 * ready promise each and no independent event or mutable-data relationship to
 * cross-check.
 */
const install = (): void => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve((ctx as unknown as { invariants: InvariantService }).invariants.register(PACKAGE_NAME, install))
