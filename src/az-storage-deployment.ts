import * as storage from 'azure-storage';
import * as fs from 'fs';
import _, { chunk } from 'lodash';
import * as mime from 'mime-types';
import { join, resolve } from 'path';
import { promisify } from 'util';
export type AccessibleStatePropertyNames<T> = { [K in keyof T]: T[K] extends Function ? K : never }[keyof T];

export class DeploymentManager {
  private blobService: storage.BlobService;
  /**
   * Used for managing deployments to an azure storage account. Supports deploying new versions and cleaning up prior versions
   * 
   * @param connectionString Azure storage account connection string
   * @param currentVersion Version to be managed e.g. master.1234 or 2.0.1
   * @param container Container within the azure storage account to be deployed to
   * @param chunkSize Number of concurrent azure storage operations. Defaults to 50
   * @param numberOfRetries Specify azure storage operation retry. Defaults to 3
   */
  constructor (
    connectionString: string,
    private currentVersion: string,
    private container: string,
    private chunkSize = 50,
    private numberOfRetries = 3
  ) {
    this.blobService = new storage.BlobService(connectionString);
    this.blobService.parallelOperationThreadCount = chunkSize;
  }

  /**
   * Uploads a directory to `currentVersion`
   * @param localLocation Absolute path to the directory being uploaded
   */
  async deploy (localLocation: string) {
    const filesToLoad = this.buildUpFileList(localLocation);
    const chunks = _.chunk(filesToLoad, this.chunkSize);
    for (const chunk of chunks) {
      try {
        await Promise.all(chunk.map(async (fileToLoad, index) => {
          const contents = fs.readFileSync(fileToLoad);
          let relativeLocation = join(this.currentVersion, fileToLoad.replace(localLocation, '/'));
          if (relativeLocation.startsWith('/')) {
            relativeLocation = relativeLocation.slice(1);
          }
          console.log('uploading', relativeLocation, 'to', this.container);
          try {
            await this.tryUpload(relativeLocation, contents);
          } catch (e) {
            console.error('upload', index, 'failed with', e);
            throw e;
          }
        }));
      } catch (e) {
        // node 10 requires explicit throws
        throw e;
      }
    }
  }

  /**
   * Used for cleaning up existing builds from a single branch and prior branches/builds. !!SHOULD NOT BE USED ON A STAGING ENVIRONMENT e.g. UAT
   * 
   *    - if used on a staging environment that contains a newer version of the production app, this will remove the assets for the production app
   * 
   * e.g. current version is 1.5.20, this will remove 1.0.0 - 1.5.19
   */
  async cleanup () {
    const majorChunks = this.currentVersion.split('.');
    const minorChunks = majorChunks;
    this.validateMinorVersionChunks(minorChunks);
    this.validateMajorVersionChunks(majorChunks);

    const existingFiles = await this.loadSegments('');
    const filesToBeRemoved = existingFiles.reduce<string[]>((acc, chunk) => ([
      ...acc,
      ...chunk.entries
        .filter(entry => {
          return majorChunks.length === 3 ?
            this.checkIfFileShouldBeDeletedMajor(entry, majorChunks) :
            this.checkIfFileShouldBeDeletedMinor(entry, minorChunks);
        })
        .map(ent => ent.name)
    ]), []);

    await this.performCleanup(filesToBeRemoved);
  }


  private checkIfFileShouldBeDeletedMinor (
    ent: storage.BlobService.BlobResult,
    [branch, patch]: [string, string]
  ) {
    return ent.name.startsWith(`${branch}.`) && !ent.name.startsWith(`${branch}.${patch}/`);
  }

  private checkIfFileShouldBeDeletedMajor (
    ent: storage.BlobService.BlobResult,
    [major, minor]: [string, string, string]
  ) {
    return ent.name.startsWith(`${major}.`) && !ent.name.startsWith(`${major}.${minor}.`);
  }
  private validateMajorVersionChunks (
    version: string[]
  ): asserts version is [string, string, string] {
    if (version.length < 3) {
      throw new Error();
    }
  }

  private validateMinorVersionChunks (
    version: string[]
  ): asserts version is [string, string] {
    if (version.length < 2) {
      throw new Error()
    }
  }

  private async performCleanup (filesToBeRemoved: string[]) {
    const existingBlobEntries = _.chunk(filesToBeRemoved, this.chunkSize);

    for (const chunk of existingBlobEntries) {
      await Promise.all(chunk.map(async (entry) => {
        console.log('deleting', entry, 'from', this.container);
        await this.tryDelete(entry);
      }));
    }
  }

  private validateMinorVersion () {
    if (!this.currentVersion.includes('.')) {
      throw new Error('Version does not conform. Must match <branch_name>.<build_number>');
    }
  }

  private validateMajorVersion () {
    if (this.currentVersion.split('.').length < 3) {
      throw new Error('Version does not conform. Must match <major_version>.<minor_version>.<patch_version>');
    }
  }

  private async tryDelete (entry: string): Promise<void> {
    await this.callBlobService('deleteBlobIfExists', this.container, entry, {});
  }

  private tryUpload (
    relativeLocation: string,
    contents: Buffer
  ): Promise<any> {
    return this.callBlobService<any, [container: string, blob: string, text: string | Buffer, options: storage.BlobService.CreateBlobRequestOptions], storage.BlobService.BlobResult>(
      'createBlockBlobFromText',
      this.container,
      relativeLocation,
      contents,
      {
        contentSettings: {
          contentType: mime.lookup(relativeLocation.split('/').pop()!) || 'application/octet-stream'
        }
      }
    );
  }
  private async loadSegments (
    folderName: string,
    continuationToken: storage.common.ContinuationToken|null = null,
    pages: storage.BlobService.ListBlobsResult[] = []
  ): Promise<storage.BlobService.ListBlobsResult[]> {
    const existingFiles = await this.callBlobService('listBlobsSegmentedWithPrefix', this.container, folderName, continuationToken!, {});
    pages = [
      ...pages,
      existingFiles
    ];
    if (existingFiles.continuationToken) {
      return this.loadSegments(folderName, existingFiles.continuationToken, pages);
    } else {
      return pages;
    }
  }

  private buildUpFileList (
    root: string
  ): string[] {
    return fs.readdirSync(root)
      .reduce<string[]>((acc, file) => {
        const fileName = resolve(root, file);
        const stats = fs.statSync(fileName);
  
        if (stats.isFile()) {
          return [
            ...acc,
            fileName
          ];
        } else if (stats.isDirectory()) {
          return [
            ...acc,
            ...this.buildUpFileList(fileName)
          ];
        } else {
          return acc;
        }
      }, []);
  }

  private callBlobService<
    K extends AccessibleStatePropertyNames<storage.BlobService>,
    Args extends PromisifyCallbackArgs<storage.BlobService[K]>,
    Return extends PromisifyCallbackReturn<storage.BlobService[K]>
  >(key: K, ...args: Args): Promise<Return> {
    const fn = promisify(this.blobService[key].bind(this.blobService));

    let attempt = 0;
    const doCall = async (): Promise<Return> => {
      try {
        const result: Return = await fn(...args);

        return result;
      } catch (e) {
        ++attempt;
        console.log(`Error calling ${key}. Attempt ${attempt}`);

        if (attempt < this.numberOfRetries) {
          return doCall();
        }

        throw e;
      }
    };

    return doCall();
  }
  
}
type Callback<T> = (err: Error, arg: T) => any;
type FnWithCallback<P extends any[], T> = (...args: [...args: P, callback: Callback<T>]) => any;
type PromisifyCallbackResults<T extends FnWithCallback<any[], any>> = T extends FnWithCallback<infer P, infer T> ? { Args: P; Return: T } : never;
type PromisifyCallbackArgs<T extends FnWithCallback<any[], any>> = PromisifyCallbackResults<T>['Args'];
type PromisifyCallbackReturn<T extends FnWithCallback<any[], any>> = PromisifyCallbackResults<T>['Return'];
