import { Command, OptionValues } from 'commander';
import { AZDeploymentManager } from './deployment';

export class AzDeploymentCli {
  private command = this.program.command('az');

  constructor (
    private program: Command
  ) {
    this.setupOptions();
  }

  private setupDeployment (opts: OptionValues) {
    const manager = new AZDeploymentManager(
      opts.currentVersion,
      opts.container || '$web',
      opts.verbose,
      +opts.chunkSize,
      +opts.retries,
      +opts.maxPages,
      opts.dryRun
    );

    manager.init(opts.connectionString);

    return manager;
  }

  private setupOptions () {
    const deployCommand = this.setupDeploymentCommand('deploy');
    deployCommand
      .requiredOption('-p, --path <directory>', 'Absolute path to the directory being deployed')
      .description('Deploys a given folder to the storage container')
      .action(async () => {
        const opts = deployCommand.opts();
        const deploymentManager = this.setupDeployment(opts);

        await deploymentManager.deploy(opts.path);
      });
    
    const cleanupCommand = this.setupDeploymentCommand('cleanup')
      .description('Removes prior builds from the storage container')
      .action(async () => {
        const deploymentManager = this.setupDeployment(cleanupCommand.opts());

        deploymentManager.cleanup();
      });
  }

  private setupDeploymentCommand (commandName: string) {
    return this.command.command(commandName)
      .requiredOption('--current-version <version>', 'Version to be currently deployed')
      .requiredOption('--connection-string <string>', 'Azure storage account connection string')
      .option('--verbose', 'Enable verbose logging', false)
      .option('--container', 'Container within storage account to deploy to', '$web')
      .option('--chunk-size <number>', 'Number of concurrent storage account operations', '50')
      .option('--retries <number>', 'Number of attempts on operation failure', '3')
      .option('--max-pages <number>', 'Number of pages loaded for cleanup', '50')
      .option('--dry-run', 'Do not perform uploads or deletes', false);
  }
}
