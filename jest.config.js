module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  maxWorkers: 1,
  clearMocks: true,
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { esModuleInterop: true, strict: true, target: 'ES2022' } }] },
};
