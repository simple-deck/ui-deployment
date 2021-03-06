import { Command } from 'commander';
import { AzDeploymentCli } from './az/cli';

export class Entry {
  static program = new Command();
  static init (): void {
    new AzDeploymentCli(this.program as Command);

    this.program.parse();
  }
}