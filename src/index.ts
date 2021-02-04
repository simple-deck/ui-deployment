import { Command, InvalidOptionArgumentError } from 'commander';
import { DeploymentManager } from './az-storage-deployment';

export class Entry {
  static program = new Command();

  static parseInt(value: string) {
    // parseInt takes a string and a radix
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
      throw new InvalidOptionArgumentError('Not a number.');
    }
    return parsedValue;
  }

  static setupDeployment () {
    const opts = this.program.opts();

    return new DeploymentManager(
      opts.connectionString,
      opts.version,
      opts.container
    );
  }

  static setupOptions () {
    this.setupDeploymentCommand('deploy')
      .requiredOption('-p, --path <directory>', 'Absolute path to the directory being deployed')
      .description('Deploys a given folder to the storage container')
      .action(async () => {
        const deploymentManager = this.setupDeployment();
        const opts = this.program.opts();

        await deploymentManager.deploy(opts.path);
      });
    
    this.setupDeploymentCommand('cleanup')
      .description('Removes prior builds from the storage container')
      .action(async () => {
        const deploymentManager = this.setupDeployment();

        deploymentManager.cleanup();
      });
  }

  static setupDeploymentCommand (commandName: string) {
    return this.program.command(commandName)
      .requiredOption('-v, --version <version>', 'Version to be currently deployed')
      .option('-c, --connection-string <string>', 'Azure storage account connection string')
      .requiredOption('--container', 'Container within storage account to deploy to', '$web')
      .option('--chunk-size', 'Number of concurrent storage account operations', '50')
  }

  static init () {
    this.setupOptions();
    this.program.parse();
  }
}