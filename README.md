# FireFly Node.js SDK

![version](https://img.shields.io/github/package-json/v/hyperledger/firefly-sdk-nodejs?label=firefly-sdk-nodejs)
[![FireFly Documentation](https://img.shields.io/static/v1?label=FireFly&message=documentation&color=informational)](https://hyperledger.github.io/firefly/latest)

![Hyperledger FireFly](./images/hyperledger_firefly_logo.png)

This is the client SDK for Node.js, allowing you to build your own applications on top of Hyperledger FireFly.

## Installation

```bash
npm install @hyperledger/firefly-sdk
```

## Usage

```typescript
import FireFly from '@hyperledger/firefly-sdk';

async function main() {
  const firefly = new FireFly({ host: 'http://localhost:5000' });
  await firefly.sendBroadcast({
    data: [
      {
        value: 'test-message',
      },
    ],
  });
}

if (require.main === module) {
  main().catch((err) => console.error(`Error: ${err}`));
}
```

(This example was taken from the [examples](examples) folder where you will find some other basic samples)

## Generated schemas

The types for FireFly requests and responses are generated from the OpenAPI schema for FireFly. If you have
the `firefly` repository cloned in a folder parallel to this one, you can run the following to re-generate
the TypeScript interfaces from the latest FireFly definitions:

```bash
npm run schema
```

## Git repositories

There are multiple Git repos making up the Hyperledger FireFly project. Some others
that may be helpful to reference:

- Core - https://github.com/hyperledger-firefly/firefly
- Command Line Interface (CLI) - https://github.com/hyperledger-firefly/firefly-cli
- FireFly Sandbox - https://github.com/hyperledger-firefly/firefly-sandbox

## Contributing

Interested in contributing to the community?

Check out our [Contributor Guide](https://hyperledger.github.io/firefly/latest/contributors/index), and welcome!

Please adhere to this project's [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Hyperledger Project source code files are made available under the Apache License, Version 2.0 (Apache-2.0), located in the [LICENSE](LICENSE) file.
