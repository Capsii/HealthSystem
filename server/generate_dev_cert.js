'use strict';

const fs = require('node:fs');
const path = require('node:path');
const selfsigned = require('selfsigned');

async function generate() {
  const certificateDirectory = path.join(__dirname, 'cert');
  const keyPath = path.join(certificateDirectory, 'localhost-dev-key.pem');
  const certificatePath = path.join(
    certificateDirectory,
    'localhost-dev-cert.pem',
  );
  if (fs.existsSync(keyPath) || fs.existsSync(certificatePath)) {
    throw new Error(
      'A development certificate file already exists. Refusing to overwrite it.',
    );
  }
  const result = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      keySize: 2048,
      days: 365,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    },
  );
  fs.mkdirSync(certificateDirectory, { recursive: true });
  fs.writeFileSync(keyPath, result.private, { flag: 'wx', mode: 0o600 });
  try {
    fs.writeFileSync(certificatePath, result.cert, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    fs.rmSync(keyPath, { force: true });
    throw error;
  }
  console.info(
    'Generated ignored, self-signed localhost development certificate files.',
  );
}

if (require.main === module) {
  generate().catch((error) => {
    console.error('Development certificate generation failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { generate };
