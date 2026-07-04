import { type DynamicModule, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import { ClsModule } from 'nestjs-cls';
import { JobsModule } from '@nest-native/jobs';
import { SqliteJobStore } from '@nest-native/jobs/sqlite';
import { type AppDatabase, DRIZZLE } from './database';
import {
  BillingChargeHandler,
  ReportGenerateHandler,
  WelcomeEmailHandler,
} from './handlers';
import { UserService } from './user.service';

// A global module exporting the Drizzle instance, so both the CLS adapter and
// JobsModule resolve it (mirrors how @nest-native/drizzle registers).
@Module({})
class DbModule {}

@Module({})
export class AppModule {
  static register(db: AppDatabase): DynamicModule {
    const dbModule: DynamicModule = {
      module: DbModule,
      global: true,
      providers: [{ provide: DRIZZLE, useValue: db }],
      exports: [DRIZZLE],
    };
    return {
      module: AppModule,
      imports: [
        dbModule,
        ClsModule.forRoot({
          global: true,
          plugins: [
            new ClsPluginTransactional({
              adapter: new TransactionalAdapterDrizzleOrm({
                drizzleInstanceToken: DRIZZLE,
              }),
              enableTransactionProxy: true,
            }),
          ],
        }),
        JobsModule.forRoot({
          drizzleInstanceToken: DRIZZLE,
          store: new SqliteJobStore(),
        }),
      ],
      providers: [
        UserService,
        WelcomeEmailHandler,
        ReportGenerateHandler,
        BillingChargeHandler,
      ],
      exports: [UserService],
    };
  }
}
