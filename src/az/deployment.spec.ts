import { mkdirSync, rmdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { AZDeploymentManager } from './deployment';


describe('AZ Deployment', () => {
  let currentVersion = '';
  const container = '';
  const chunkSize = 5;
  const numberOfRetries = 3;
  const maxPages = 5;

  function getMockedManager () {
    const manager = new AZDeploymentManager(
      currentVersion,
      container,
      false,
      chunkSize,
      numberOfRetries,
      maxPages
    );

    return manager;
  }

  let deploymentManager: AZDeploymentManager = getMockedManager();

  beforeEach(() => {
    deploymentManager = getMockedManager();
  });

  describe('buildUpFileList', () => {
    const root = resolve(__dirname, 'tmp');
    beforeAll(() => {
      mkdirSync(root);

      writeFileSync(resolve(root, 'root_file'), '');

      mkdirSync(resolve(root, 'nested'));
      writeFileSync(resolve(root, 'nested', 'file'), '');
      writeFileSync(resolve(root, 'nested', 'file_2'), '');
      
      mkdirSync(resolve(root, 'nested', 'nestednested'));
      writeFileSync(resolve(root, 'nested', 'nestednested', 'file'), '');
      writeFileSync(resolve(root, 'nested', 'nestednested', 'file_2'), '');
    });

    it('should be able to load up a directory tree', () => {
      const fileList = deploymentManager['buildUpFileList'](root);

      expect(fileList).toEqual([
        resolve(root, 'nested', 'file'),
        resolve(root, 'nested', 'file_2'),
        resolve(root, 'nested', 'nestednested', 'file'),
        resolve(root, 'nested', 'nestednested', 'file_2'),
        resolve(root, 'root_file')
      ]);
    });

    afterAll(() => {
      rmdirSync(root, {
        recursive: true
      });
    });
  });

  describe('chunkedRequest', () => {
    it('should never exceed chunk size', async () => {
      let count = 0;
      let maxCount = 0;
      const items = Array(chunkSize * 5).fill('');

      async function chunkFn () {
        ++count;

        if (count > maxCount) {
          maxCount = count;
        }

        await new Promise<void>((r) => setTimeout(() => r(), Math.random() * 15));

        --count;
      }


      await deploymentManager['chunkedRequest'](items, chunkFn);

      expect(maxCount).toEqual(chunkSize);
    });

    it('should preserve order of arguments', async () => {
      const items = [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10
      ];

      async function chunkFn (item: number) {
        await new Promise<void>((r) => setTimeout(() => r(), Math.random() * 15));

        return item + 1;
      }

      const returnedItems = await deploymentManager['chunkedRequest'](items, chunkFn);

      expect(returnedItems).toEqual([
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11
      ]);
    });
  });

  describe('determineFilesToBeRemoved', () => {
    const irrelevantFiles = [
      'some.other.folder/file1',
      'some.other.folder/file2',
      'some.other.folder/file3'
    ];
    const currentMinorFiles = [
      'master.123/file1',
      'master.123/file2',
      'master.123/file3'
    ];
    const previousMinorFiles = [
      'master.122/file1',
      'master.122/file2',
      'master.122/file3'
    ];
    const futureMinorFiles = [
      'master.124/file1',
      'master.124/file2',
      'master.124/file3'
    ];
    const allMinorFiles = [
      ...currentMinorFiles,
      ...previousMinorFiles,
      ...futureMinorFiles
    ];
    const currentMajorFiles = [
      '1.2.3/file1',
      '1.2.3/file2',
      '1.2.3/file3'
    ];
    const futurePatchMajorFiles = [
      '1.2.4/file1',
      '1.2.4/file2',
      '1.2.4/file3'
    ];
    const futureMinorMajorFiles = [
      '1.3.3/file1',
      '1.3.3/file2',
      '1.3.3/file3'
    ];
    const previousPatchMajorFiles = [
      '1.2.2/file1',
      '1.2.2/file2',
      '1.2.2/file3'
    ];
    const previousMinorMajorFiles = [
      '1.1.3/file1',
      '1.1.3/file2',
      '1.1.3/file3'
    ];
    const allMajorFiles = [
      ...currentMajorFiles,
      ...futurePatchMajorFiles,
      ...futureMinorMajorFiles,
      ...previousPatchMajorFiles,
      ...previousMinorMajorFiles
    ];
    const allFiles = [
      ...irrelevantFiles,
      ...allMinorFiles,
      ...allMajorFiles
    ];

    const allMappedFiles = allFiles.map(name => ({ name, contentLength: 1 }));

    beforeEach(() => {
      deploymentManager['loadSegments'] = async () => {
        return allMappedFiles;
      };
    });

    describe('with major version', () => {
      currentVersion = '1.2.3';
      const filesToBeDeleted = deploymentManager['determineFilesToBeRemoved'](
        allMappedFiles,
        currentVersion
      );

      it('should not include current files for this version', () => {
        const currentVersionsIncluded = currentMajorFiles.some(file => filesToBeDeleted.some(({ name }) => file === name));

        expect(currentVersionsIncluded).toBeFalsy();
      });

      it('should not include future versions of this version', () => {
        const futureVersionsIncluded = [
          ...futureMinorMajorFiles,
          ...futurePatchMajorFiles
        ].some(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(futureVersionsIncluded).toBeFalsy();
      });

      it('should not include versions of another branch', () => {
        const otherVersionsIncluded = allMinorFiles.some(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(otherVersionsIncluded).toBeFalsy();
      });

      it('should not include irrelevant files', () => {
        const irrelevantFilesIncluded = irrelevantFiles.some(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(irrelevantFilesIncluded).toBeFalsy();
      });

      it('should include prior minor releases', () => {
        const allPriorMinorIncluded = previousMinorMajorFiles.every(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(allPriorMinorIncluded).toBeTruthy();
      });

      it('should include prior patch releases', () => {
        const allPriorPatchIncluded = previousPatchMajorFiles.every(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(allPriorPatchIncluded).toBeTruthy();
      });
    });

    describe('with minor version', () => {
      currentVersion = 'master.123';
      const filesToBeDeleted = deploymentManager['determineFilesToBeRemoved'](
        allMappedFiles,
        currentVersion
      );

      it('should not include current files for this version', () => {
        const currentVersionsIncluded = currentMinorFiles.some(file => filesToBeDeleted.some(({ name }) => file === name));

        expect(currentVersionsIncluded).toBeFalsy();
      });


      it('should not include future versions of this version', () => {
        const futureVersionsIncluded = futureMinorFiles.some(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(futureVersionsIncluded).toBeFalsy();
      });

      it('should not include versions of another branch', () => {
        const otherVersionsIncluded = allMajorFiles.some(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(otherVersionsIncluded).toBeFalsy();
      });

      it('should not include irrelevant files', () => {
        const irrelevantFilesIncluded = irrelevantFiles.some(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(irrelevantFilesIncluded).toBeFalsy();
      });

      it('should include prior minor releases', () => {
        const allPriorMinorIncluded = previousMinorFiles.every(file => filesToBeDeleted.some(({ name }) => name === file));

        expect(allPriorMinorIncluded).toBeTruthy();
      });
    });
  });
});
