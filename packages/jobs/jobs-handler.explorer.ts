import { Injectable, type OnApplicationBootstrap, type Type } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { JOB_HANDLER_NAME, type JobHandler } from './job-handler.decorator';

/**
 * The slice of Nest's `InstanceWrapper` the explorer relies on, captured
 * locally so the package does not depend on the wrapper's full internal type.
 */
interface InstanceWrapperLike {
  instance?: unknown;
  metatype?: unknown;
}

/**
 * Discovers `@JobHandler(name)` provider classes in the Nest container and
 * builds the name → handler-instance registry the claimer dispatches through.
 *
 * Discovery happens once, at application bootstrap (so every module has
 * finished instantiating its providers). Exactly one handler per job name:
 * a second class claiming an already-registered name throws, failing the
 * application at startup instead of silently shadowing a handler at runtime.
 */
@Injectable()
export class JobsHandlerExplorer implements OnApplicationBootstrap {
  private readonly registry = new Map<string, JobHandler>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders() as InstanceWrapperLike[]) {
      this.register(wrapper);
    }
  }

  /** The handler registered for `name`, if any. */
  get(name: string): JobHandler | undefined {
    return this.registry.get(name);
  }

  /** Every registered job name (useful for diagnostics and tests). */
  names(): readonly string[] {
    return [...this.registry.keys()];
  }

  private register(wrapper: InstanceWrapperLike): void {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) {
      return;
    }
    const name = this.reflector.get<string | undefined>(
      JOB_HANDLER_NAME,
      metatype as Type,
    );
    if (name === undefined) {
      return;
    }
    const existing = this.registry.get(name);
    if (existing && existing !== instance) {
      throw new Error(
        `Duplicate @JobHandler("${name}"): ${(metatype as Type).name} conflicts ` +
          'with an already-registered handler. Job names must map to exactly one handler.',
      );
    }
    this.registry.set(name, instance as JobHandler);
  }
}
