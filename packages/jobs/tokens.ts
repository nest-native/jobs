// DI tokens for the jobs engine.

/** The dialect-specific {@link JobStore} provided to `JobsModule`. */
export const JOBS_STORE = Symbol.for('@nest-native/jobs:store');

/**
 * The base (non-transactional) Drizzle instance the claimer opens its own
 * transaction on. `JobsModule` aliases this to the user-supplied
 * `drizzleInstanceToken`.
 */
export const JOBS_DRIZZLE = Symbol.for('@nest-native/jobs:drizzle');

/** The resolved {@link JobsModuleOptions}. */
export const JOBS_OPTIONS = Symbol.for('@nest-native/jobs:options');
