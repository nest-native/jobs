import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: '@nest-native/jobs',
  tagline:
    'Background jobs for NestJS without Redis — a Drizzle-backed job queue',
  favicon: 'img/logo.svg',

  future: {
    v4: true,
  },

  url: 'https://nest-native.dev',
  baseUrl: '/jobs/',

  organizationName: 'nest-native',
  projectName: 'jobs',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/nest-native/jobs/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/logo.svg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: '@nest-native/jobs',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://www.npmjs.com/package/@nest-native/jobs',
          label: 'npm',
          position: 'right',
        },
        {
          href: 'https://github.com/nest-native/jobs',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Introduction', to: '/docs/introduction'},
            {label: 'Quick Start', to: '/docs/quick-start'},
            {label: 'API Reference', to: '/docs/api-reference'},
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/nest-native/jobs',
            },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/@nest-native/jobs',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} @nest-native/jobs contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
