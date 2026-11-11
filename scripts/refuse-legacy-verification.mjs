// Fail closed: never import tests, production modules, credentials, or a provider.
console.error(
  'Verification refused: historical model-response substitutes are prohibited.\n' +
    'Use npm run check:static, npm run test:nonmodel, and npm run test:package:nonmodel for component checks only.\n' +
    'Real API acceptance is separate and pending; see docs/verification-policy.md.',
);
process.exitCode = 1;
