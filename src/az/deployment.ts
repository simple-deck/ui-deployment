import * as storage from 'azure-storage';
import * as fs from 'fs';
import chunk from 'lodash.chunk';
import * as mime from 'mime-types';
import { join, resolve } from 'path';
import { promisify } from 'util';
export type AccessibleStatePropertyNames<T> = { [K in keyof T]: T[K] extends Function ? K : never }[keyof T];

export interface StorageEntry {
  contentLength: number;
  name: string;
}

export class AZDeploymentManager {
  private blobService?: storage.BlobService;
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
    private currentVersion: string,
    private container: string,
    private verbose = false,
    private chunkSize = 50,
    private numberOfRetries = 3,
    private maxPages = 50,
    private dryRun = false
  ) {
  }

  async init (connectionString: string) {
    this.blobService = new storage.BlobService(connectionString);
    this.blobService.parallelOperationThreadCount = this.chunkSize;
  }

  /**
   * Uploads a directory to `currentVersion`
   * @param localLocation Absolute path to the directory being uploaded
   */
  async deploy (localLocation: string) {
    this.log('starting cleanup for ' + this.currentVersion, ' at ' + localLocation);

    const filesToLoad = this.buildUpFileList(localLocation);

    await this.chunkedRequest(filesToLoad, async (fileToLoad) => {
      const contents = fs.readFileSync(fileToLoad);
      let relativeLocation = join(this.currentVersion, fileToLoad.replace(localLocation, '/'));
      if (relativeLocation.startsWith('/')) {
        relativeLocation = relativeLocation.slice(1);
      }
      this.log('uploading', relativeLocation, 'to', this.container);
      await this.tryUpload(relativeLocation, contents);
    });
  }

  /**
   * Used for cleaning up existing builds from a single branch and prior branches/builds. !!SHOULD NOT BE USED ON A STAGING ENVIRONMENT e.g. UAT
   * 
   *    - if used on a staging environment that contains a newer version of the production app, this will remove the assets for the production app
   * 
   * e.g. current version is 1.5.20, this will remove 1.0.0 - 1.5.19
   */
  async cleanup () {
    const start = Date.now();
    this.log('starting cleanup for ' + this.currentVersion);

    const allLoadedFiles = await this.loadSegments('');

    this.log('Found ' + allLoadedFiles.length + ' files');


    const filesToBeRemoved = this.determineFilesToBeRemoved(
      allLoadedFiles,
      this.currentVersion
    );

    this.log(filesToBeRemoved.length + ' files found for cleanup.');

    const cleanupResult = await this.performCleanup(
      filesToBeRemoved
    );
    this.log('Failed files:')
    this.log(cleanupResult.failedFiles);
    const actionSuffix = this.dryRun ? 'Would have' : 'Successfully';
    console.log(`
${actionSuffix} removed ${cleanupResult.totalDeletedFiles} files totaling ${(cleanupResult.totalDeletedBytes / 1024 / 1024).toFixed(2)}MB.
${actionSuffix} left ${allLoadedFiles.length - filesToBeRemoved.length}.
Completed in ${(Date.now() - start) / 1000}s.
${cleanupResult.failedFiles.length || 'No'} files failed to be removed.`
    );
  }

  private async chunkedRequest<T, R> (items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const chunks = chunk(items, this.chunkSize);
    const resultChunks: R[][] = [];
    await Promise.all(Array(this.chunkSize).fill('').map(async (_, index) => {
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const individualChunk = chunks[chunkIndex];
        const resultChunk = (resultChunks[chunkIndex] = resultChunks[chunkIndex] || []);
        
        if (index in individualChunk) {
          const individualResult = await fn(individualChunk[index]);
          resultChunk[index] = individualResult;
        } else {
          break;
        }
      }
    }));

    return resultChunks.reduce((acc, resultChunk) => {
      return [
        ...acc,
        ...resultChunk
      ];
    });
  }

  private determineFilesToBeRemoved<T extends { name: string }> (
    allLoadedFileNames: T[],
    version: string
  ) {
    const mappedVersion = this.mapVersion(version);

    return allLoadedFileNames.filter(entry => {
      const willRemove = this.validateMajorVersionChunks(mappedVersion) ?
        this.checkIfFileShouldBeDeletedMajor(entry, mappedVersion) :
        this.checkIfFileShouldBeDeletedMinor(entry, mappedVersion);

      if (!willRemove) {
        this.log('not deleting', entry);
      }

      return willRemove;
    });
  }

  private mapVersion (
    version: string
  ): [string, number]|[number, number, number] {
    const chunks = version.split('.');
    let mappedVersion: [string, number]|[number, number, number]|undefined;
    if (chunks.length === 2) {
      mappedVersion = [
        chunks[0],
        +chunks[1]
      ];

      if (isNaN(mappedVersion[1])) {
        throw new Error('Invalid version ' + version + '. must be <branch_string>.<build_int>')
      }
    } else if (chunks.length === 3) {
      mappedVersion = [
        +chunks[0],
        +chunks[1],
        +chunks[2]
      ];

      if (mappedVersion.some(mappedVersionChunk => isNaN(mappedVersionChunk))) {
        throw new Error('Invalid version ' + version + '. must be <major_int>.<minor_int>.<patch_int>')
      }
    }

    if (!mappedVersion) {
      throw new Error('Invalid version ' + version);
    }
    
    return mappedVersion;
  }

  private log (...args: Parameters<Console['log']>) {
    if (this.verbose) {
      console.log(...args);
    }
  }


  private checkIfFileShouldBeDeletedMinor (
    ent: { name: string },
    [branch, patch]: [string, number]
  ) {
        // version is inferred from the folder it is in
    const fileVersion = ent.name.split('/')[0];

    const [fileBranch, filePatch, ...otherChunks] = fileVersion.split('.');

    // check that the folder conforms to <branch>.<patch>
    if (!otherChunks.length && !isNaN(+filePatch)) {
      // it should be deleted if the file is built off of this branch
      return fileBranch === branch &&
        // and the patch version is older than this version
        (+filePatch < patch);
    }

    // keep files that don't conform to that pattern
    return false;
  }

  private checkIfFileShouldBeDeletedMajor (
    ent: { name: string },
    [major, minor, patch]: [number, number, number]
  ) {
    // version is inferred from the folder it is in
    const fileVersion = ent.name.split('/')[0];
    const fileVersionChunks = fileVersion.split('.');

    // check that the folder conforms to <major>.<minor>.<patch>
    if (
      fileVersionChunks.length === 3 &&
      fileVersionChunks.every(v => !isNaN(+v))
    ) {
      const fileMajor = +fileVersionChunks[0];
      const fileMinor = +fileVersionChunks[1];
      const filePatch = +fileVersionChunks[2];

      // should delete if the file is the same major version
      return fileMajor === major &&
        fileMinor === minor ?
          // same minor version, but older patch version
          filePatch < patch :
          // or the minor version is older
          fileMinor < minor;
    }

    // keep files that don't conform to that pattern
    return false;
  }

  private validateMajorVersionChunks (
    version: any[]
  ): version is [number, number, number] {
    if (version.length === 3) {
      return true;
    }

    return false;
  }

  private async performCleanup (filesToBeRemoved: StorageEntry[]) {
    let totalDeletedBytes = 0;
    let totalDeletedFiles = 0;
    let failedFiles: StorageEntry[] = [];

    await this.chunkedRequest(filesToBeRemoved, async (entry) => {
      try {
        await this.tryDelete(entry.name);
        ++totalDeletedFiles;
        totalDeletedBytes += +entry.contentLength;
      } catch (e) {
        failedFiles.push(entry);
      }
    })

    return {
      totalDeletedBytes,
      totalDeletedFiles,
      failedFiles
    };
  }

  private async tryDelete (entry: string): Promise<void> {
    if (this.dryRun) {
      return undefined;
    }
    await this.callBlobService('deleteBlobIfExists', this.container, entry, {});
  }

  private async tryUpload (
    relativeLocation: string,
    contents: Buffer
  ): Promise<void> {
    if (this.dryRun) {
      return undefined;
    }

    await this.callBlobService<any, [container: string, blob: string, text: string | Buffer, options: storage.BlobService.CreateBlobRequestOptions], storage.BlobService.BlobResult>(
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
  ): Promise<StorageEntry[]> {
    const doLoadSegment = async (
      continuationToken: storage.common.ContinuationToken|null = null,
      pageNumber: number,
      results: StorageEntry[]
    ): Promise<StorageEntry[]> => {
      this.log(`loading page ${++pageNumber} of existing files`);
      const segment = await this.callBlobService(
        'listBlobsSegmentedWithPrefix',
        this.container,
        folderName,
        continuationToken!,
        {}
      );

      results = [
        ...results,
        ...segment.entries.map(entry => ({
          name: entry.name,
          contentLength: +entry.contentLength
        }))
      ];

      if (segment.continuationToken) {
        return doLoadSegment(
          segment.continuationToken,
          pageNumber,
          results
        );
      }

      this.log(`loaded ${pageNumber} pages`);

      return results;
    }

    return doLoadSegment(null, 0, []);
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

  private async callBlobService<
    K extends AccessibleStatePropertyNames<storage.BlobService>,
    Args extends PromisifyCallbackArgs<storage.BlobService[K]>,
    Return extends PromisifyCallbackReturn<storage.BlobService[K]>
  > (key: K, ...args: Args): Promise<Return> {
    if (!this.blobService) {
      throw new ReferenceError('Manager has not been initialized, make sure to call `.init` with a connection string');
    }

    const fn = promisify(this.blobService[key].bind(this.blobService));

    let attempt = 0;
    const doCall = async (): Promise<Return> => {
      try {
        const result: Return = await fn(...args);

        return result;
      } catch (e) {
        ++attempt;
        console.warn(`Error calling ${key}. Attempt ${attempt} of ${this.numberOfRetries}`);

        if (attempt < this.numberOfRetries) {
          return doCall();
        }

        throw e;
      }
    };

    return await doCall();
  }
  
}
type Callback<T> = (err: Error, arg: T) => any;
type FnWithCallback<P extends any[], T> = (...args: [...args: P, callback: Callback<T>]) => any;
type PromisifyCallbackResults<T extends FnWithCallback<any[], any>> = T extends FnWithCallback<infer P, infer R> ? { Args: P; Return: R } : never;
type PromisifyCallbackArgs<T extends FnWithCallback<any[], any>> = PromisifyCallbackResults<T>['Args'];
type PromisifyCallbackReturn<T extends FnWithCallback<any[], any>> = PromisifyCallbackResults<T>['Return'];
