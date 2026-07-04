import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  icon: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Transactional Enqueue',
    icon: 'Tx',
    description: (
      <>
        <code>enqueue()</code> inserts the job row inside your business
        transaction via nestjs-cls, so the job exists if and only if your
        writes committed. No Redis, no dual-write bug.
      </>
    ),
  },
  {
    title: 'Nest-Native Handlers',
    icon: 'DI',
    description: (
      <>
        Declare a class with <code>@JobHandler('email.welcome')</code> and
        register it as a provider. Handlers are discovered at bootstrap with
        full dependency injection; duplicate names fail at startup.
      </>
    ),
  },
  {
    title: 'Your Drizzle Database',
    icon: 'DB',
    description: (
      <>
        Per-dialect stores for better-sqlite3 (sync), Postgres, and MySQL
        (async), with a <code>jobs</code> table you add to your schema and
        migrate with drizzle-kit. The core engine stays dialect-agnostic.
      </>
    ),
  },
  {
    title: 'Retries, Delays & Unique Jobs',
    icon: 'Re',
    description: (
      <>
        Jittered exponential backoff, <code>RetryableError</code> /
        <code> PermanentError</code> steering, <code>runAt</code> /
        <code> delayMs</code> scheduling, <code>priority</code> ordering, and
        <code> uniqueKey</code> dedup among active jobs.
      </>
    ),
  },
  {
    title: 'Zero Runtime Dependencies',
    icon: 'Zero',
    description: (
      <>
        The published package keeps runtime dependencies empty. Nest, Drizzle,
        and your driver stay under the host application's control as peer
        dependencies.
      </>
    ),
  },
  {
    title: '100% Tested',
    icon: 'Test',
    description: (
      <>
        The engine is covered to 100% across branches, functions, lines, and
        statements — all three dialects, with a gated real-MySQL round-trip
        proving the dedup contract on a live server.
      </>
    ),
  },
];

function Feature({title, icon, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md feature-card">
        <div className={styles.featureIcon}>{icon}</div>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
