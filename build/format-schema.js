"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const is_glob_1 = __importDefault(require("is-glob"));
const path_1 = require("path");
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const yaml_ast_parser_1 = require("yaml-ast-parser");
/*
package:
  - $
  - orig-file: $
  - directory:
      into: $
      include:
        - $
      exclude:
        - $
problemset-definition: $
problemset-variants: $
*/
class SchemaNode {
    constructor(node) {
        this._mappings = new Map();
        this._items = [];
        this._validateScalars = false;
        this._kind = node.kind;
        this._key = node.key ? node.key.value : null;
        this._value =
            node.kind === yaml_ast_parser_1.Kind.MAPPING ? new SchemaNode(node.value) : null;
        switch (node.kind) {
            case yaml_ast_parser_1.Kind.MAP:
                node.mappings.forEach(mapping => {
                    this._mappings.set(mapping.key.value, new SchemaNode(mapping));
                });
                break;
            case yaml_ast_parser_1.Kind.SEQ:
                node.items.forEach(item => {
                    if (item.kind === yaml_ast_parser_1.Kind.SCALAR && item.value[0] === '$') {
                        this._validateScalars = true;
                        this._key = item.value;
                    }
                    else if (item.kind === yaml_ast_parser_1.Kind.MAP) {
                        item.mappings.forEach(mapping => {
                            this._items.push(new SchemaNode(mapping));
                            // this._items.set(mapping.key.value, new SchemaNode(mapping));
                        });
                    }
                });
                break;
        }
    }
    validateNode(node) {
        if (node.kind !== this._kind) {
            return false;
        }
        else if (node.key) {
            if (!this._key) {
                return false;
            }
            else {
                if (this._key[0] === '$') {
                    return true;
                }
                else if (node.key.value !== this._key) {
                    return false;
                }
            }
        }
        return true;
    }
    get kind() {
        return this._kind;
    }
    get key() {
        return this._key;
    }
    get value() {
        return this._value;
    }
    get mappings() {
        return this._mappings;
    }
    get items() {
        return this._items;
    }
    get validateScalars() {
        return this._validateScalars;
    }
}
class FormatValidation {
    constructor(_schema) {
        this._schema = _schema;
        this._routes = new Map();
        this._subpath = '';
        this._textDoc = vscode_languageserver_protocol_1.TextDocument.create('', '', 0, '');
        this._nodeX = null;
        this._formatValues = new Map();
        if (this._schema.kind === yaml_ast_parser_1.Kind.MAP) {
            this._schema.mappings.forEach(mapping => {
                this._routes.set(mapping.key.value, new SchemaNode(mapping.value));
            });
        }
    }
    set subPath(subPath) {
        this._subpath = subPath;
    }
    getDiagnostics(node, doc) {
        this._nodeX = node;
        this._textDoc = doc;
        return this.validate(node);
    }
    getCompletionItems(params) {
        if (this._nodeX) {
            this.isRelatedCompletion(this._nodeX, this._textDoc.offsetAt(params.position));
        }
        return [];
    }
    validate(node, schema) {
        if (!schema) {
            if (!node) {
                return [];
            }
            if (node.key) {
                const route = this._routes.get(node.key.value);
                if (route) {
                    return this.validate(node.value, route);
                }
            }
        }
        else {
            if (!schema.validateNode(node)) {
                return [];
            }
        }
        switch (node.kind) {
            case yaml_ast_parser_1.Kind.ANCHOR_REF:
                return this.validateAnchorReference(node, schema);
            case yaml_ast_parser_1.Kind.MAP:
                return this.validateMap(node, schema);
            case yaml_ast_parser_1.Kind.MAPPING:
                return this.validateMapping(node, schema);
            case yaml_ast_parser_1.Kind.SEQ:
                return this.validateSequence(node, schema);
            case yaml_ast_parser_1.Kind.SCALAR:
                if (schema && schema.key && schema.key[0] === '$') {
                    return this.validateScalar(node, schema.key);
                }
            default:
                return [];
        }
    }
    validateAnchorReference(node, schema) {
        return this.validate(node.value, schema);
    }
    validateMap(node, schema) {
        let result = [];
        if (!schema) {
            node.mappings.forEach(mapping => {
                result = result.concat(this.validate(mapping, schema));
            });
        }
        else {
            node.mappings.forEach(mapping => {
                const schemaMapping = schema.mappings.get(mapping.key.value);
                if (schemaMapping && schemaMapping.value) {
                    result = result.concat(this.validate(mapping.value, schemaMapping.value));
                }
            });
        }
        return result;
    }
    validateMapping(node, schema) {
        if (!schema) {
            return this.validate(node.value);
        }
        else {
            let result = [];
            if (schema.key && schema.key[0] === '$') {
                if (schema.value && schema.value.kind === node.value.kind) {
                    result = result.concat(this.validateScalar(node.key, schema.key));
                }
            }
            if (schema.value) {
                result = result.concat(this.validate(node.value, schema.value));
            }
            return result;
        }
    }
    validateSequence(node, schema) {
        let result = [];
        if (!schema) {
            node.items.forEach(item => {
                result = result.concat(this.validate(item, schema));
            });
        }
        else {
            node.items.forEach(item => {
                if (schema.validateScalars &&
                    item.kind === yaml_ast_parser_1.Kind.SCALAR &&
                    schema.key &&
                    !node.value) {
                    result = result.concat(this.validateScalar(item, schema.key));
                    return;
                }
                else if (item.kind === yaml_ast_parser_1.Kind.MAP) {
                    item.mappings.forEach(mapping => {
                        schema.items.forEach(schemaItem => {
                            if (schemaItem.key === mapping.key.value) {
                                result = result.concat(this.validate(mapping, schemaItem));
                            }
                            else if (schemaItem.key && schemaItem.key[0] === '$') {
                                result = result.concat(this.validate(mapping, schemaItem));
                            }
                        });
                    });
                }
            });
        }
        return result;
    }
    validateScalar(node, format) {
        if (is_glob_1.default(node.value)) {
            return [];
        }
        else if (format.length < 2) {
            const scalarPath = path_1.join(this._subpath, node.value);
            return fs_1.existsSync(scalarPath)
                ? []
                : [
                    vscode_languageserver_protocol_1.Diagnostic.create(vscode_languageserver_protocol_1.Range.create(this._textDoc.positionAt(node.startPosition), this._textDoc.positionAt(node.endPosition)), `File not found: ${scalarPath}`, 1),
                ];
        }
        else {
            const formatVariables = format.split('/');
            if (formatVariables.length === 1) {
                this._formatValues.set(formatVariables[0], node.value);
                const scalarPath = path_1.join(this._subpath, node.value);
                return fs_1.existsSync(scalarPath)
                    ? []
                    : [
                        vscode_languageserver_protocol_1.Diagnostic.create(vscode_languageserver_protocol_1.Range.create(this._textDoc.positionAt(node.startPosition), this._textDoc.positionAt(node.endPosition)), `File not found: ${scalarPath}`, 1),
                    ];
            }
            else {
                const formatPaths = [];
                formatVariables.forEach(variable => {
                    if (this._formatValues.has(variable)) {
                        formatPaths.push(this._formatValues.get(variable));
                    }
                });
                if (formatPaths.length !== formatVariables.length - 1) {
                    return [
                        vscode_languageserver_protocol_1.Diagnostic.create(vscode_languageserver_protocol_1.Range.create(this._textDoc.positionAt(node.startPosition), this._textDoc.positionAt(node.endPosition)), `File on higher level not found.`, 1),
                    ];
                }
                else {
                    const scalarPath = path_1.join(this._subpath, ...formatPaths, node.value);
                    return fs_1.existsSync(scalarPath)
                        ? []
                        : [
                            vscode_languageserver_protocol_1.Diagnostic.create(vscode_languageserver_protocol_1.Range.create(this._textDoc.positionAt(node.startPosition), this._textDoc.positionAt(node.endPosition)), `File not found: ${scalarPath}`, 1),
                        ];
                }
            }
        }
    }
    isRelatedCompletion(node, position) {
        const route = [];
        let changed = true;
        while (node.kind !== yaml_ast_parser_1.Kind.SCALAR && changed) {
            changed = false;
            if (node.key &&
                node.key.startPosition < position &&
                node.key.endPosition > position) {
                return false;
            }
            switch (node.kind) {
                case yaml_ast_parser_1.Kind.ANCHOR_REF:
                    node = node.value;
                    changed = true;
                    break;
                case yaml_ast_parser_1.Kind.MAP:
                    node.mappings.forEach(mapping => {
                        if (mapping.startPosition < position &&
                            mapping.endPosition > position) {
                            node = mapping;
                            changed = true;
                        }
                    });
                    break;
                case yaml_ast_parser_1.Kind.MAPPING:
                    const valueKind = this.resolveKind(node);
                    if (valueKind) {
                        route.push({
                            key: node.key ? node.key.value : '',
                            kind: valueKind,
                        });
                        node = node.value;
                        changed = true;
                    }
                    break;
                case yaml_ast_parser_1.Kind.SEQ:
                    node.items.forEach(item => {
                        if (item.startPosition < position && item.endPosition > position) {
                            node = item;
                            changed = true;
                        }
                    });
                    break;
            }
        }
        const schemaRoute = this._routes.get(route[0].key);
        return true;
    }
    resolveKind(node) {
        if (node.value && node.kind === yaml_ast_parser_1.Kind.ANCHOR_REF) {
            return this.resolveKind(node.value);
        }
        else if (node.value) {
            return node.value.kind;
        }
        else {
            return null;
        }
    }
}
exports.FormatValidation = FormatValidation;
