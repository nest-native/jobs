import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { JobsModuleOptions, JobStore } from './interfaces';
import { JobsClaimer } from './jobs-claimer.service';
import { JobsHandlerExplorer } from './jobs-handler.explorer';
import { JobsService } from './jobs.service';
import { JOBS_DRIZZLE, JOBS_OPTIONS, JOBS_STORE } from './tokens';

/**
 * Async configuration. The Drizzle token is static (a DI token is known at
 * module-definition time); the store is built by a factory so it can inject
 * runtime providers (e.g. configuration).
 */
export interface JobsModuleAsyncOptions {
  isGlobal?: boolean;
  /** Token of the base (non-transactional) Drizzle instance. */
  drizzleInstanceToken: symbol | string;
  imports?: ModuleMetadata['imports'];
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  // `any[]` (not `unknown[]`) mirrors Nest's own `FactoryProvider.useFactory`, so
  // an idiomatic factory whose params match `inject` (e.g. `(cfg: Config) => …`)
  // is assignable under `strictFunctionTypes` without forcing the caller to cast.
  useStore: (...args: any[]) => JobStore | Promise<JobStore>;
}

@Module({})
export class JobsModule {
  static forRoot(options: JobsModuleOptions): DynamicModule {
    return assemble(options.isGlobal ?? true, options.imports ?? [], [
      { provide: JOBS_OPTIONS, useValue: options },
      { provide: JOBS_STORE, useValue: options.store },
      { provide: JOBS_DRIZZLE, useExisting: options.drizzleInstanceToken },
    ]);
  }

  static forRootAsync(options: JobsModuleAsyncOptions): DynamicModule {
    return assemble(options.isGlobal ?? true, options.imports ?? [], [
      {
        provide: JOBS_STORE,
        useFactory: options.useStore,
        inject: options.inject ?? [],
      },
      { provide: JOBS_DRIZZLE, useExisting: options.drizzleInstanceToken },
    ]);
  }
}

function assemble(
  global: boolean,
  imports: NonNullable<ModuleMetadata['imports']>,
  base: Provider[],
): DynamicModule {
  return {
    module: JobsModule,
    global,
    // DiscoveryModule powers the @JobHandler scan at bootstrap.
    imports: [DiscoveryModule, ...imports],
    providers: [...base, JobsService, JobsClaimer, JobsHandlerExplorer],
    exports: [JobsService, JobsClaimer, JobsHandlerExplorer],
  };
}
