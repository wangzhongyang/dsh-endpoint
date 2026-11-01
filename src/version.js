import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The package version, read once from package.json. */
export const VERSION = require('../package.json').version
