/* eslint no-underscore-dangle: 0 */
const ngHtmlParser = require('angular-html-parser');

const fs = require('fs');
const babelParser = require('@babel/parser');
const babelTraverse = require('@babel/traverse').default;
const _ = require('lodash');
const path = require('path');
const { generateKey } = require('@transifex/native');

const mergePayload = require('./merge');
const { stringToArray, mergeArrays } = require('./utils');

/**
 * Create an extraction payload
 *
 * @param {String} string
 * @param {Object} params
 * @param {String} params._context
 * @param {String} params._comment
 * @param {Number} params._charlimit
 * @param {Number} params._tags
 * @param {String} occurence
 * @param {String[]} appendTags
 * @returns {Object} Payload
 * @returns {String} Payload.string
 * @returns {String} Payload.key
 * @returns {String} Payload.meta.context
 * @returns {String} Payload.meta.developer_comment
 * @returns {Number} Payload.meta.character_limit
 * @returns {String[]} Payload.meta.tags
 * @returns {String[]} Payload.meta.occurrences
 */
function createPayload(string, params, occurence, appendTags) {
  return {
    string,
    key: generateKey(string, params),
    meta: _.omitBy({
      context: stringToArray(params._context),
      developer_comment: params._comment,
      character_limit: params._charlimit ? parseInt(params._charlimit, 10) : undefined,
      tags: mergeArrays(stringToArray(params._tags), appendTags),
      occurrences: [occurence],
    }, _.isNil),
  };
}

/**
 * Check if payload coming from createPayload is valid based on tag filters
 *
 * @param {Object} payload
 * @param {String[]} options.filterWithTags
 * @param {String[]} options.filterWithoutTags
 * @returns {Boolean}
 */
function isPayloadValid(payload, options = {}) {
  const { filterWithTags, filterWithoutTags } = options;
  let isValid = true;
  _.each(filterWithTags, (tag) => {
    if (!_.includes(payload.meta.tags, tag)) {
      isValid = false;
    }
  });
  _.each(filterWithoutTags, (tag) => {
    if (_.includes(payload.meta.tags, tag)) {
      isValid = false;
    }
  });
  return isValid;
}

/**
 * Check if callee is a valid Transifex Native function
 *
 * @param {*} node
 * @returns {Boolean}
 */
function isTransifexCall(node) {
  const { callee } = node;
  if (!callee) return false;
  if (_.includes(['t', 'useT'], callee.name)) { return true; }
  if (!callee.object || !callee.property) return false;
  if (callee.property.name === 'translate') return true;
  return false;
}

/**
 * Global regexp to find use of TranslatePipe.
 */
const pipeRegexpG = /{{\s*?['|"]([\s\S]+?)['|"]\s*?\|\s*?translate\s*?:?({[\s\S]*?})?\s*?}}/gi;

/**
 * Regexp to find use of TranslatePipe and match with capture groups.
 */
const pipeRegexp = /{{\s*?['|"]([\s\S]+?)['|"]\s*?\|\s*?translate\s*?:?({[\s\S]*?})?\s*?}}/i;

/**
 * Regexp to find use of TranslatePipe in Attributes;
 */
const pipeBindingRegexp = /'([\s\S]+?)'\s*?\|\s*?translate\s*?:?({[\s\S]*?})?/i;

/**
 * Loosely parses string (from HTML) to an object.
 *
 * According to Mozilla a bit better than eval().
 *
 * @param {str} obj
 * @returns {*}
 */
function looseJsonParse(obj) {
  let parsed;

  try {
    // eslint-disable-next-line no-new-func
    parsed = Function(`"use strict";return (${obj})`)();
  } catch (err) {
    parsed = {};
  }

  return parsed;
}

/**
 * Parse an HTML file and detects T/UT tags and usage of TranslatePipe
 *
 * @param {Object} HASHES
 * @param {String} filename
 * @param {String} relativeFile
 * @param {String[]} appendTags
 * @param {Object} options
 * @returns void
 */
function parseHTMLTemplateFile(HASHES, filename, relativeFile,
  appendTags, options) {
  const TXComponents = [];
  const TXTemplateStrings = [];

  function parseTemplateText(text) {
    const textStr = _.trim(String(text));

    if (textStr.length) {
      const results = String(textStr).match(pipeRegexpG);

      if (results && results.length) {
        _.each(results, (result) => {
          const lineResult = result.match(pipeRegexp);

          if (lineResult) {
            const string = lineResult[1];
            const paramsStr = lineResult[2];

            const params = looseJsonParse(paramsStr) || {};

            if (string && params) {
              TXTemplateStrings.push({
                string,
                params,
              });
            }
          }
        });
      }
    }
  }

  function parseTemplateBindingText(text) {
    const textStr = _.trim(String(text));

    if (textStr.length) {
      const result = textStr.match(pipeBindingRegexp);

      if (result) {
        const string = result[1];
        const paramsStr = result[2];

        const params = looseJsonParse(paramsStr) || {};

        if (string && params) {
          TXTemplateStrings.push({
            string,
            params,
          });
        }
      }
    }
  }

  function parseTemplateNode(children) {
    if (children) {
      _.each(children, (child) => {
        if (child.name === 'T' || child.name === 'UT') {
          TXComponents.push(child);
        } else if (child.type === 'text') {
          parseTemplateText(child.value);
        } else if (child.attrs && child.attrs.length > 0) {
          const attributes = child.attrs.filter((a) => a.value.includes('translate'));

          _.each(attributes, (attr) => {
            parseTemplateBindingText(attr.value);
          });
        }

        parseTemplateNode(child.children);
      });
    }
  }

  const data = fs.readFileSync(filename, 'utf8');
  const { rootNodes, errors } = ngHtmlParser.parse(data);
  if (errors.length) return;

  parseTemplateNode(rootNodes);
  _.each(TXComponents, (txcmp) => {
    let string = '';
    let key = '';
    const params = {};
    if (txcmp.attrs) {
      _.each(txcmp.attrs, (attribute) => {
        if (attribute.name === 'str') {
          string = attribute.value;
        } else if (attribute.name === 'key') {
          key = attribute.value;
        } else {
          params[attribute.name] = attribute.value;
        }
      });
    }
    if (string) {
      const partial = createPayload(string, params, relativeFile, appendTags);
      if (!isPayloadValid(partial, options)) return;

      mergePayload(HASHES, {
        [key || partial.key]: {
          string: partial.string,
          meta: partial.meta,
        },
      });
    }
  });

  _.each(TXTemplateStrings, (txStr) => {
    let key = '';

    if (txStr.params.key) {
      key = txStr.params.key;
    }

    const partial = createPayload(txStr.string, txStr.params, relativeFile, appendTags);
    if (!isPayloadValid(partial, options)) return;

    mergePayload(HASHES, {
      [key || partial.key]: {
        string: partial.string,
        meta: partial.meta,
      },
    });
  });
}

function _parse(source) {
  try {
    return babelParser.parse(
      source,
      {
        sourceType: 'unambiguous',
        plugins: [
          'decorators-legacy',
          'classProperties',
          'jsx',
          'typescript',
        ],
      },
    );
  } catch (e) {
    return babelParser.parse(
      source,
      {
        sourceType: 'unambiguous',
        plugins: [
          'decorators-legacy',
          'jsx',
          'flow',
        ],
      },
    );
  }
}

/**
 * Find value bound to some identifier with passed name.
 *
 * @param {Object} scope AST Scope to use for lookup.
 * @param {String} name Name of the identifier.
 * @returns {String?} declared value or null.
 */
function findIdentifierValue(scope, name) {
  if (!scope) return null;

  if (scope.bindings[name]) {
    const binding = scope.bindings[name];

    if (binding.kind !== 'const') return null;
    const { node } = binding.path;

    if (node.type === 'VariableDeclarator' && node.init) {
      // eslint-disable-next-line no-use-before-define
      return findDeclaredValue(scope, node.init);
    }
  }

  if (scope.path.parentPath) {
    return findIdentifierValue(scope.path.parentPath.scope, name);
  }

  return null;
}

/**
 * Find declared value bound to identifier defined in init.
 *
 * @param {Object} scope AST Scope to use for lookup.
 * @param {Object} init AST Node to work with.
 * @returns {String?} declared value or null.
 */
function findDeclaredValue(scope, init) {
  if (!init) return null;

  if (init.type === 'StringLiteral') {
    return init.value;
  }

  if (init.type === 'NumericLiteral') {
    return init.value;
  }

  if (init.type === 'JSXExpressionContainer') {
    return findDeclaredValue(scope, init.expression);
  }

  if (init.type === 'Identifier') {
    return findIdentifierValue(scope, init.name);
  }

  if (init.type === 'BinaryExpression' && init.operator === '+') {
    const left = findDeclaredValue(scope, init.left);
    const right = findDeclaredValue(scope, init.right);

    if (_.isString(left) && _.isString(right)) {
      return left + right;
    }
  }

  if (init.type === 'TemplateLiteral') {
    const expressions = init.expressions.map((node) => findDeclaredValue(scope, node));
    if (expressions.includes(null)) return null;

    const elements = init.quasis.flatMap(
      ({ tail, value }, i) => (tail ? value.raw : [value.raw, expressions[i]]),
    );
    return elements.join('');
  }

  return null;
}

/**
 * Parse file and extract phrases using AST
 *
 * @param {String} file absolute file path
 * @param {String} relativeFile occurence
 * @param {Object} options
 * @param {String[]} options.appendTags
 * @param {String[]} options.filterWithTags
 * @param {String[]} options.filterWithoutTags
 * @returns {Object}
 */
function extractPhrases(file, relativeFile, options = {}) {
  const { appendTags } = options;
  const HASHES = {};
  const source = fs.readFileSync(file, 'utf8');
  if (path.extname(file) !== '.html') {
    let parseSrc = source;
    if (path.extname(file) === '.md') {
      parseSrc = jsxtremeMarkdown.toComponentModule(source);
    }
    const ast = _parse(parseSrc);
    babelTraverse(ast, {
    // T / UT functions
      CallExpression({ node, scope }) {
      // Check if node is a Transifex function
        if (!isTransifexCall(node)) return;
        if (_.isEmpty(node.arguments)) return;

        // Try to find the value of first argument
        const string = findDeclaredValue(scope, node.arguments[0]);

        // Verify that at least the string is passed to the function
        if (!_.isString(string)) return;

        // Extract function parameters
        const params = {};
        if (
          node.arguments[1]
        && node.arguments[1].type === 'ObjectExpression'
        ) {
          _.each(node.arguments[1].properties, (prop) => {
          // get only string on number params
            const value = findDeclaredValue(scope, prop.value);
            if (_.isString(value) || _.isNumber(value)) {
              params[prop.key.name] = value;
            }
          });
        }

        const partial = createPayload(string, params, relativeFile, appendTags);
        if (!isPayloadValid(partial, options)) return;

        mergePayload(HASHES, {
          [partial.key]: {
            string: partial.string,
            meta: partial.meta,
          },
        });
      },

      // Decorator
      Decorator({ node }) {
        const elem = node.expression;

        if (!elem || !elem.arguments || !elem.arguments.length) return;
        if (!node.expression.callee.name === 'T') return;

        let string = '';
        let key = '';
        const params = {};
        _.each(node.expression.arguments, (arg) => {
          if (arg.type === 'StringLiteral') {
            string = arg.value;
          } else if (arg.type === 'ObjectExpression') {
            _.each(arg.properties, (prop) => {
              if (prop.key.name === '_key') {
                key = prop.value.value;
              } else {
                params[prop.key.name] = prop.value.value;
              }
            });
          }
        });

        if (string) {
          const partial = createPayload(string, params, relativeFile, appendTags);
          if (!isPayloadValid(partial, options)) return;

          mergePayload(HASHES, {
            [key || partial.key]: {
              string: partial.string,
              meta: partial.meta,
            },
          });
        }
      },

      // React component
      JSXElement({ node, scope }) {
        const elem = node.openingElement;

        if (!elem || !elem.name) return;
        if (elem.name.name !== 'T' && elem.name.name !== 'UT') return;

        let string;
        const params = {};
        _.each(elem.attributes, (attr) => {
          const property = attr.name && attr.name.name;
          if (!property || !attr.value) return;

          const attrValue = findDeclaredValue(scope, attr.value);
          if (!attrValue) return;

          if (property === '_str') {
            string = attrValue;
            return;
          }
          params[property] = attrValue;
        });

        if (!string) return;

        const partial = createPayload(string, params, relativeFile, appendTags);
        if (!isPayloadValid(partial, options)) return;

        mergePayload(HASHES, {
          [partial.key]: {
            string: partial.string,
            meta: partial.meta,
          },
        });
      },
    });
  } else if (path.extname(file) === '.html') {
    parseHTMLTemplateFile(HASHES, file, relativeFile, appendTags, options);
  }

  return HASHES;
}

module.exports = extractPhrases;
