import { Convert, LanguageClientConnection } from 'atom-languageclient';
import { CancellationToken } from 'vscode-jsonrpc';
import {
  CompletionItem,
  CompletionList,
  CompletionParams,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  DidSaveTextDocumentParams,
  Hover,
  PublishDiagnosticsParams,
  TextDocumentPositionParams,
  TextEdit,
  WillSaveTextDocumentParams,
} from 'vscode-languageserver-protocol';
import { SuperDocument } from './document-manager';

export class SuperConnection extends LanguageClientConnection {
  /* Mapping URIs to their SuperDocuments. Key is an URI and the value is an
  SuperDocument with all the includes resolved. */
  private _docs: Map<string, SuperDocument> = new Map();
  /* Mapping URIs to their current version. Key: URI, value: version number. */
  private _versions: Map<string, number> = new Map();

  /* Only calls super method, if the doc wasn't opened direcly/via include ref.
  Otherwise Atom has the diagnostics already in the memory thanks to other doc. */
  public didOpenTextDocument(params: DidOpenTextDocumentParams): void {
    /* If doc wasn't open yet, creating new SuperDocument from params. */
    if (!this._docs.has(params.textDocument.uri)) {
      const doc = new SuperDocument(
        params.textDocument.text,
        params.textDocument.uri,
        params.textDocument.version,
      );

      /* Assigning SuperDocument and initial version to all subdocuments. */
      doc.relatedUris.forEach(uri => {
        this._docs.set(uri, doc);
        this._versions.set(uri, params.textDocument.version);
      });

      super.didOpenTextDocument(doc.DidOpenTextDocumentParams);
    }
  }

  public didChangeTextDocument(params: DidChangeTextDocumentParams): void {
    let docVersion = this._versions.get(params.textDocument.uri);

    /* Increasing version number of all related docs. */
    if (docVersion) {
      docVersion++;

      for (const key of this._versions.keys()) {
        if (key === params.textDocument.uri) {
          this._versions.set(key, docVersion);
        }
      }
    }

    const doc = new SuperDocument(
      params.contentChanges[0].text,
      params.textDocument.uri,
      docVersion ? docVersion : 1,
    );

    const relatedUris = doc.relatedUris;

    this._docs.forEach((value, key) => {
      /* If doc was related before, but now it's not, it's need to send to the
      server to get the correct diagnostics for it. */
      if (relatedUris.indexOf(key) < 0 && doc.uri === value.uri) {
        const unrelatedDoc = SuperDocument.getBasicTextDocument(
          Convert.uriToPath(key),
        );

        if (unrelatedDoc) {
          super.didChangeTextDocument({
            contentChanges: [
              {
                text: unrelatedDoc.getText(),
              },
            ],
            textDocument: {
              uri: key,
              /* Version needs to be atleast = 1, otherwise server will ignore it */
              version: docVersion ? docVersion : 1,
            },
          });
        }
      }
    });

    relatedUris.forEach(uri => {
      this._docs.set(uri, doc);
    });

    super.didChangeTextDocument(doc.DidChangeTextDocumentParams);
  }

  public willSaveTextDocument(params: WillSaveTextDocumentParams): void {
    const doc = this._docs.get(params.textDocument.uri);

    if (doc) {
      return super.willSaveTextDocument(
        doc.getwillSaveTextDocumentParams(params),
      );
    }

    return super.willSaveTextDocument(params);
  }

  public willSaveWaitUntilTextDocument(
    params: WillSaveTextDocumentParams,
  ): Promise<TextEdit[] | null> {
    const doc = this._docs.get(params.textDocument.uri);

    if (doc) {
      return super
        .willSaveWaitUntilTextDocument(
          doc.getwillSaveTextDocumentParams(params),
        )
        .then(value => {
          if (!value) {
            return value;
          }

          return doc.transformTextEditArray(value);
        });
    }

    return super.willSaveWaitUntilTextDocument(params);
  }

  public didSaveTextDocument(params: DidSaveTextDocumentParams): void {
    const doc = this._docs.get(params.textDocument.uri);

    if (doc) {
      super.didSaveTextDocument(doc.getDidSaveTextDocumentParams(params));
    } else {
      super.didSaveTextDocument(params);
    }
  }

  public didCloseTextDocument(params: DidCloseTextDocumentParams): void {
    // TODO: check how to does this effect the extension.
  }

  public onPublishDiagnostics(
    callback: (params: PublishDiagnosticsParams) => void,
  ): void {
    const newCallback = (params: PublishDiagnosticsParams) => {
      const doc = this._docs.get(params.uri);

      if (doc) {
        doc.filterDiagnostics(params).forEach(filteredParams => {
          callback(filteredParams);
        });
      } else {
        callback(params);
      }
    };

    super.onPublishDiagnostics(newCallback);
  }

  public completion(
    params: TextDocumentPositionParams | CompletionParams,
    cancellationToken?: CancellationToken,
  ): Promise<CompletionItem[] | CompletionList> {
    const doc = this._docs.get(params.textDocument.uri);

    if (doc) {
      return super.completion(
        doc.getCompletionParams(params),
        cancellationToken,
      );
    }

    return super.completion(params, cancellationToken);
  }

  public hover(params: TextDocumentPositionParams): Promise<Hover | null> {
    const doc = this._docs.get(params.textDocument.uri);

    if (doc) {
      return super.hover(doc.getTextDocumentPositionParams(params));
    }

    return super.hover(params);
  }
}
