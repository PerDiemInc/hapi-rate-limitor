'use strict'

const { registerCompletionHandler } = require('ava')

// AVA 6+ waits for the event loop to drain. The suite keeps one Redis connection
// per server across a test file, so exit explicitly once the file's tests finish.
registerCompletionHandler(() => process.exit())
