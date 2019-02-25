/* @flow */
import {
  CodegenRunner,
  ConsoleReporter,
  WatchmanClient,
  DotGraphQLParser,
  type GetWriterOptions,
} from 'graphql-compiler';

import RelaySourceModuleParser from 'relay-compiler/lib/RelaySourceModuleParser';
import RelayFileWriter from 'relay-compiler/lib/RelayFileWriter';
import RelayIRTransforms from 'relay-compiler/lib/RelayIRTransforms';
import RelayLanguagePluginJavascript from 'relay-compiler/lib/RelayLanguagePluginJavaScript';

import fs from 'fs';
import path from 'path';
import {
  buildASTSchema,
  buildClientSchema,
  parse,
  printSchema,
  type GraphQLSchema,
} from 'graphql';

const {
  commonTransforms,
  codegenTransforms,
  fragmentTransforms,
  printTransforms,
  queryTransforms,
  schemaExtensions,
} = RelayIRTransforms;

export default async function run(options: {
  schema: string,
  src: string,
  extensions: $ReadOnlyArray<string>,
  include: $ReadOnlyArray<string>,
  exclude: $ReadOnlyArray<string>,
  verbose: boolean,
  watchman: boolean,
  watch?: ?boolean,
  validate: boolean,
  quiet: boolean,
  noFutureProofEnums: boolean,
  language: string,
  artifactDirectory: ?string,
  customScalars: { [key: string]: string },
}) {
  const schemaPath = path.resolve(process.cwd(), options.schema);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`--schema path does not exist: ${schemaPath}.`);
  }
  const srcDir = path.resolve(process.cwd(), options.src);
  if (!fs.existsSync(srcDir)) {
    throw new Error(`--source path does not exist: ${srcDir}.`);
  }
  if (options.watch && !options.watchman) {
    throw new Error('Watchman is required to watch for changes.');
  }
  if (options.watch && !hasWatchmanRootFile(srcDir)) {
    throw new Error(
      `
--watch requires that the src directory have a valid watchman "root" file.

Root files can include:
- A .git/ Git folder
- A .hg/ Mercurial folder
- A .watchmanconfig file

Ensure that one such file exists in ${srcDir} or its parents.
    `.trim(),
    );
  }
  if (options.verbose && options.quiet) {
    throw new Error("I can't be quiet and verbose at the same time");
  }

  const reporter = new ConsoleReporter({
    verbose: options.verbose,
    quiet: options.quiet,
  });

  const useWatchman = options.watchman && (await WatchmanClient.isAvailable());

  const schema = getSchema(schemaPath);

  const languagePlugin = getLanguagePlugin(options.language);

  const inputExtensions = options.extensions || languagePlugin.inputExtensions;
  const outputExtension = languagePlugin.outputExtension;

  const sourceParserName = inputExtensions.join('/');
  const sourceWriterName = outputExtension;

  const sourceModuleParser = RelaySourceModuleParser(
    languagePlugin.findGraphQLTags,
  );

  const providedArtifactDirectory = options.artifactDirectory;
  const artifactDirectory =
    providedArtifactDirectory != null
      ? path.resolve(process.cwd(), providedArtifactDirectory)
      : null;

  const generatedDirectoryName = artifactDirectory || '__generated__';

  const sourceSearchOptions = {
    extensions: inputExtensions,
    include: options.include,
    exclude: ['**/*.graphql.*', ...options.exclude], // Do not include artifacts
  };
  const graphqlSearchOptions = {
    extensions: ['graphql'],
    include: options.include,
    exclude: [path.relative(srcDir, schemaPath)].concat(options.exclude),
  };

  const parserConfigs = {
    [sourceParserName]: {
      baseDir: srcDir,
      getFileFilter: sourceModuleParser.getFileFilter,
      getParser: sourceModuleParser.getParser,
      getSchema: () => schema,
      watchmanExpression: useWatchman
        ? buildWatchExpression(sourceSearchOptions)
        : null,
      filepaths: useWatchman
        ? null
        : getFilepathsFromGlob(srcDir, sourceSearchOptions),
    },
    graphql: {
      baseDir: srcDir,
      getParser: DotGraphQLParser.getParser,
      getSchema: () => schema,
      watchmanExpression: useWatchman
        ? buildWatchExpression(graphqlSearchOptions)
        : null,
      filepaths: useWatchman
        ? null
        : getFilepathsFromGlob(srcDir, graphqlSearchOptions),
    },
  };
  const writerConfigs = {
    [sourceWriterName]: {
      getWriter: getRelayFileWriter(
        srcDir,
        languagePlugin,
        options.customScalars,
        options.noFutureProofEnums,
        artifactDirectory,
      ),
      isGeneratedFile: (filePath: string) =>
        filePath.endsWith(`.graphql.${outputExtension}`) &&
        filePath.includes(generatedDirectoryName),
      parser: sourceParserName,
      baseParsers: ['graphql'],
    },
  };
  const codegenRunner = new CodegenRunner({
    reporter,
    parserConfigs,
    writerConfigs,
    onlyValidate: options.validate,
    // TODO: allow passing in a flag or detect?
    sourceControl: null,
  });
  if (!options.validate && !options.watch && options.watchman) {
    // eslint-disable-next-line no-console
    console.log('HINT: pass --watch to keep watching for changes.');
  }
  const result = options.watch
    ? await codegenRunner.watchAll()
    : await codegenRunner.compileAll();

  if (result === 'ERROR') {
    process.exit(100);
  }
  if (options.validate && result !== 'NO_CHANGES') {
    process.exit(101);
  }
}

function buildWatchExpression(options: {
  extensions: $ReadOnlyArray<string>,
  include: $ReadOnlyArray<string>,
  exclude: $ReadOnlyArray<string>,
}) {
  return [
    'allof',
    ['type', 'f'],
    ['anyof', ...options.extensions.map(ext => ['suffix', ext])],
    [
      'anyof',
      ...options.include.map(include => ['match', include, 'wholename']),
    ],
    ...options.exclude.map(exclude => ['not', ['match', exclude, 'wholename']]),
  ];
}

function getFilepathsFromGlob(
  baseDir,
  options: {
    extensions: $ReadOnlyArray<string>,
    include: $ReadOnlyArray<string>,
    exclude: $ReadOnlyArray<string>,
  },
): $ReadOnlyArray<string> {
  const { extensions, include, exclude } = options;
  const patterns = include.map(inc => `${inc}/*.+(${extensions.join('|')})`);

  const glob = require('fast-glob');
  return glob.sync(patterns, {
    cwd: baseDir,
    ignore: exclude,
  });
}

type PluginInterface = $FixMe;

function getRelayFileWriter(
  baseDir: string,
  languagePlugin: PluginInterface,
  customScalars: { [key: string]: string },
  noFutureProofEnums: boolean,
  outputDir?: ?string,
) {
  return ({
    onlyValidate,
    schema,
    documents,
    baseDocuments,
    sourceControl,
    reporter,
  }: GetWriterOptions) =>
    new RelayFileWriter({
      config: {
        baseDir,
        compilerTransforms: {
          commonTransforms,
          codegenTransforms,
          fragmentTransforms,
          printTransforms,
          queryTransforms,
        },
        customScalars,
        formatModule: languagePlugin.formatModule,
        inputFieldWhiteListForFlow: [],
        schemaExtensions,
        useHaste: false,
        noFutureProofEnums,
        extension: languagePlugin.outputExtension,
        typeGenerator: languagePlugin.typeGenerator,
        outputDir,
      },
      onlyValidate,
      schema,
      baseDocuments,
      documents,
      reporter,
      sourceControl,
    });
}

function getSchema(schemaPath: string): GraphQLSchema {
  try {
    let source = fs.readFileSync(schemaPath, 'utf8');
    if (path.extname(schemaPath) === '.json') {
      source = printSchema(buildClientSchema(JSON.parse(source).data));
    }
    source = `
  directive @include(if: Boolean) on FRAGMENT_SPREAD | FIELD
  directive @skip(if: Boolean) on FRAGMENT_SPREAD | FIELD

  ${source}
  `;
    return buildASTSchema(parse(source), { assumeValid: true });
  } catch (error) {
    throw new Error(
      `
Error loading schema. Expected the schema to be a .graphql or a .json
file, describing your GraphQL server's API. Error detail:

${error.stack}
    `.trim(),
    );
  }
}

// Ensure that a watchman "root" file exists in the given directory
// or a parent so that it can be watched
const WATCHMAN_ROOT_FILES = ['.git', '.hg', '.watchmanconfig'];
function hasWatchmanRootFile(testPath) {
  while (path.dirname(testPath) !== testPath) {
    if (
      WATCHMAN_ROOT_FILES.some(file => {
        return fs.existsSync(path.join(testPath, file));
      })
    ) {
      return true;
    }
    testPath = path.dirname(testPath);
  }
  return false;
}

type PluginInitializer = $FixMe;
type LanguagePlugin = PluginInitializer | { default: PluginInitializer };

/**
 * Unless the requested plugin is the builtin `javascript` one, import a
 * language plugin as either a CommonJS or ES2015 module.
 *
 * When importing, first check if it’s a path to an existing file, otherwise
 * assume it’s a package and prepend the plugin namespace prefix.
 *
 * Make sure to always use Node's `require` function, which otherwise would get
 * replaced with `__webpack_require__` when bundled using webpack, by using
 * `eval` to get it at runtime.
 */
function getLanguagePlugin(language: string): PluginInterface {
  if (language === 'javascript') {
    return new RelayLanguagePluginJavascript();
  }

  const pluginPath = path.resolve(process.cwd(), language);
  const requirePath = fs.existsSync(pluginPath)
    ? pluginPath
    : `relay-compiler-language-${language}`;
  try {
    // eslint-disable-next-line no-eval
    let languagePlugin: LanguagePlugin = eval('require')(requirePath);
    if (languagePlugin.default) {
      languagePlugin = languagePlugin.default;
    }
    if (typeof languagePlugin === 'function') {
      return languagePlugin();
    }
    throw new Error('Expected plugin to export a function.');
  } catch (err) {
    const e = new Error(
      `Unable to load language plugin ${requirePath}: ${err.message}`,
    );
    e.stack = err.stack;
    throw e;
  }
}
