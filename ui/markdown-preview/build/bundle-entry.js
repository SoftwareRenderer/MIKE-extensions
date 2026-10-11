// Entry point for the single-file Wordgard browser bundle. The extension iframe
// loads a plain <script>, so everything Preview.js needs is exposed on `window`.
// The imports are dist files of the `wordgard` npm package, copied into the
// build dir by build-wordgard.mjs.
import { Wordgard, menuBar } from './editor.js';
import { fullSchema } from './schema.js';
import { history } from './history.js';
import { parse } from './doc.js';
import { GardState } from './state.js';
import { tables } from './table.js';
import {
    Paragraph,
    Heading,
    CodeBlock,
    CodeBlockLanguage,
    Blockquote,
    BulletList,
    OrderedList,
    ListItem,
    InlineListItem,
    HorizontalRule,
    Figure,
    Image,
    LineBreak,
    Strong,
    Emphasis,
    Code,
    Link,
    Strikethrough,
    Underline,
    Superscript,
    Subscript,
    ImageAlt,
    Table,
    Cell,
    HeaderCell,
} from './types.js';

window.WordgardEditor = { Wordgard, menuBar };
window.WordgardSchema = { fullSchema };
window.WordgardHistory = { history };
window.WordgardDoc = { parse };
window.WordgardState = { GardState };
window.WordgardTable = { tables };
window.WordgardTypes = {
    Paragraph, Heading, CodeBlock, CodeBlockLanguage, Blockquote,
    BulletList, OrderedList, ListItem, InlineListItem, HorizontalRule,
    Figure, Image, LineBreak, Strong, Emphasis, Code, Link, Strikethrough,
    Underline, Superscript, Subscript, ImageAlt,
    Table, Cell, HeaderCell,
};
