// Tests (and the proxies they spawn, which inherit this) keep secrets in files in their temp
// home, so a test run never reads or writes your real Keychain. test/secrets.test.ts covers the
// keystore code with a fake backend.
process.env.TELEGRAM_MCP_SECRET_STORE = 'file'
