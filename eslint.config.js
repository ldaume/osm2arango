import antfu from '@antfu/eslint-config'

export default antfu(
  {
    isInEditor: false,
    typescript: true,
    stylistic: true,
    formatters: true,
    ignores: [
      'dist',
      'data',
    ],
  },
  {
    rules: {
      // CLI tools intentionally write to stdout/stderr.
      'no-console': 'off',

      // Bun/Node CLIs commonly use these globals; requiring explicit imports is noisy.
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
    },
  },
)
