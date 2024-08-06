import {
  ViewPlugin,
  DecorationSet,
  EditorView,
  ViewUpdate,
  Decoration,
  WidgetType,
  keymap,
} from "@codemirror/view";
import {
  StateEffect,
  Text,
  Facet,
  Prec,
  StateField,
  EditorState,
  EditorSelection,
  TransactionSpec,
} from "@codemirror/state";
import { debouncePromise } from "./lib/utils";

/**
 * The inner method to fetch suggestions: this is
 * abstracted by `inlineCopilot`.
 */
type InlineFetchFn = (state: EditorState) => Promise<string>;

/**
 * Current state of the autosuggestion
 */
const InlineSuggestionState = StateField.define<{ suggestion: null | string }>({
  create() {
    return { suggestion: null };
  },
  update(previousValue, tr) {
    const inlineSuggestion = tr.effects.find((e) =>
      e.is(InlineSuggestionEffect)
    );
    if (tr.state.doc) {
      if (inlineSuggestion && tr.state.doc == inlineSuggestion.value.doc) {
        // There is a new selection that has been set via an effect,
        // and it applies to the current document.
        return { suggestion: inlineSuggestion.value.text };
      } else if (!tr.docChanged && !tr.selection) {
        // This transaction is irrelevant to the document state
        // and could be generate by another plugin, so keep
        // the previous value.
        return previousValue;
      }
    }
    return { suggestion: null };
  },
});

const InlineSuggestionEffect = StateEffect.define<{
  text: string | null;
  doc: Text;
}>();

/**
 * Rendered by `renderInlineSuggestionPlugin`,
 * this creates possibly multiple lines of ghostly
 * text to show what would be inserted if you accept
 * the AI suggestion.
 */
function inlineSuggestionDecoration(view: EditorView, suggestionText: string) {
  const pos = view.state.selection.main.head;
  const widgets = [];
  const w = Decoration.widget({
    widget: new InlineSuggestionWidget(suggestionText),
    side: 1,
  });
  widgets.push(w.range(pos));
  return Decoration.set(widgets);
}

export const suggestionConfigFacet = Facet.define<
  { acceptOnClick: boolean; fetchFn: InlineFetchFn },
  { acceptOnClick: boolean; fetchFn: InlineFetchFn | undefined }
>({
  combine(value) {
    return {
      acceptOnClick: !!value.at(-1)?.acceptOnClick,
      fetchFn: value.at(-1)?.fetchFn,
    };
  },
});

/**
 * Renders the suggestion inline
 * with the rest of the code in the editor.
 */
class InlineSuggestionWidget extends WidgetType {
  suggestion: string;

  /**
   * Create a new suggestion widget.
   */
  constructor(suggestion: string) {
    super();
    this.suggestion = suggestion;
  }
  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.style.opacity = "0.4";
    span.className = "cm-inline-suggestion";
    span.textContent = this.suggestion;
    span.onclick = (e) => this.accept(e, view);
    return span;
  }
  accept(e: MouseEvent, view: EditorView) {
    const config = view.state.facet(suggestionConfigFacet);
    if (!config.acceptOnClick) return;

    e.stopPropagation();
    e.preventDefault();

    const suggestionText = view.state.field(InlineSuggestionState)?.suggestion;

    // If there is no suggestion, do nothing and let the default keymap handle it
    if (!suggestionText) {
      return false;
    }

    view.dispatch({
      ...insertCompletionText(
        view.state,
        suggestionText,
        view.state.selection.main.head,
        view.state.selection.main.head
      ),
    });
    return true;
  }
}

/**
 * Listens to document updates and calls `fetchFn`
 * to fetch auto-suggestions. This relies on
 * `InlineSuggestionState` also being installed
 * in the editor’s extensions.
 */
export const fetchSuggestion = ViewPlugin.fromClass(
  class Plugin {
    cancelSuggestion = false;

    async update(update: ViewUpdate) {
      // Only fetch if the document has changed
      if (!update.docChanged) {
        // When the document has not changed but the selection has, we assume
        // the user has moved the cursor position. Therefore we cancel the
        // suggestion to avoid showing somewhere other than where it was
        // triggered from.
        if (update.selectionSet) {
          this.cancelSuggestion = true;
        }
        return;
      }

      this.cancelSuggestion = false;

      const doc = update.state.doc;

      const isAutocompleted = update.transactions.some((t) =>
        t.isUserEvent("input.complete")
      );
      if (isAutocompleted) {
        return;
      }

      //   for (const tr of update.transactions) {
      //     // Check the userEvent property of the transaction
      //     if (tr.isUserEvent("input.complete")) {
      //         console.log("Change was due to autocomplete");
      //     } else {
      //         console.log("Change was due to user input");
      //     }
      // }

      // console.log("CH", update);
      const config = update.view.state.facet(suggestionConfigFacet);
      if (!config.fetchFn) {
        console.error(
          "Unexpected issue in codemirror-copilot: fetchFn was not configured"
        );
        return;
      }
      const result = await config.fetchFn(update.state);

      // Time has now passed since the request was made. Check if in the
      // meantime we decided to cancel.
      if (this.cancelSuggestion) return;

      update.view.dispatch({
        effects: InlineSuggestionEffect.of({ text: result, doc: doc }),
      });
    }
  }
);

const renderInlineSuggestionPlugin = ViewPlugin.fromClass(
  class Plugin {
    decorations: DecorationSet;
    constructor() {
      // Empty decorations
      this.decorations = Decoration.none;
    }
    update(update: ViewUpdate) {
      const suggestionText = update.state.field(InlineSuggestionState)
        ?.suggestion;
      if (!suggestionText) {
        this.decorations = Decoration.none;
        return;
      }
      //   console.log("SUGGESTION", suggestionText, update.transactions.map(t => t.effects.map(e=>e.is(InlineSuggestionEffect))));
      //   for (const tr of update.transactions) {
      //     // Check the userEvent property of the transaction
      //     if (wasAuto){
      //       wasAuto = false;
      //       debugger;
      //     }
      //     if (tr.isUserEvent("input.complete")) {
      //         console.log("Change was due to autocomplete");
      //     } else {
      //         console.log("Change was due to user input");
      //     }
      // }
      this.decorations = inlineSuggestionDecoration(
        update.view,
        suggestionText
      );
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * Attaches a keybinding on `Tab` that accepts
 * the suggestion if there is one.
 */
const inlineSuggestionKeymap = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view) => {
        const suggestionText = view.state.field(InlineSuggestionState)
          ?.suggestion;

        // If there is no suggestion, do nothing and let the default keymap handle it
        if (!suggestionText) {
          return false;
        }

        view.dispatch({
          ...insertCompletionText(
            view.state,
            suggestionText,
            view.state.selection.main.head,
            view.state.selection.main.head
          ),
        });
        return true;
      },
    },
  ])
);

function insertCompletionText(
  state: EditorState,
  text: string,
  from: number,
  to: number
): TransactionSpec {
  return {
    ...state.changeByRange((range) => {
      if (range == state.selection.main) {
        // when there are closing brackets or similar after the cursor, remove them if they also appear in text
        // (doing this because often a user types '[', the editor inserts the ']', and the
        // AI also serves back a ']' in its response.

        // number of chars we will remove
        let nChars = 0;
        const removableChars = ["]", "}", ")", ">", ";", '"', "'"];
        for (var i = 0; i < text.length; i++) {
          if (
            removableChars.includes(text[i]) &&
            text[i] === state.sliceDoc(to + nChars, to + nChars + 1)
          ) {
            nChars++;
          }
        }
        return {
          changes: [
            { from: from, to: to, insert: text },
            { from: to, to: to + nChars },
          ],
          range: EditorSelection.cursor(from + text.length),
        };
      }
      const len = to - from;
      if (
        !range.empty ||
        (len &&
          state.sliceDoc(range.from - len, range.from) !=
            state.sliceDoc(from, to))
      ) {
        return { range };
      }
      return {
        changes: { from: range.from - len, to: range.from, insert: text },
        range: EditorSelection.cursor(range.from - len + text.length),
      };
    }),
    userEvent: "input.complete",
  };
}

/**
 * Options to configure the AI suggestion UI.
 */
type InlineSuggestionOptions = {
  fetchFn: InlineFetchFn;
  /**
   * Delay after typing to query the API. A shorter
   * delay will query more often, and cost more.
   */
  delay?: number;

  /**
   * Whether clicking the suggestion will
   * automatically accept it.
   */
  acceptOnClick?: boolean;
};

/**
 * Configure the UI, state, and keymap to power
 * auto suggestions.
 */
export function inlineSuggestion(options: InlineSuggestionOptions) {
  const { delay = 500, acceptOnClick = true } = options;
  const fetchFn = debouncePromise(options.fetchFn, delay);
  return [
    suggestionConfigFacet.of({ acceptOnClick, fetchFn }),
    InlineSuggestionState,
    fetchSuggestion,
    renderInlineSuggestionPlugin,
    inlineSuggestionKeymap,
  ];
}
