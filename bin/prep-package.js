const { writeFileSync } = require('fs');
const { resolve } = require('path');
const package = require('../package.json');
const newPackage = {
  private: package.private,
  name: package.name,
  version: package.version,
  license: package.license,
  repository: package.repository,
  bin: package.bin,
  main: package.main,
  dependencies: package.dependencies
};
const distDirectory = resolve(__dirname, '..', 'dist');
console.log(newPackage);
writeFileSync(
  resolve(distDirectory, 'package.json'),
  JSON.stringify(newPackage, null, '  ')
);

