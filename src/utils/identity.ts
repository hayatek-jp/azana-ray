// SPDX-FileCopyrightText: 2026 KATO Hayate <dev@hayatek.jp>
// SPDX-License-Identifier: AGPL-3.0-only

const alphabets = 'abcdefghijklmnopqrstuvwxyz';
const numbers = '0123456789';
const replacements = {
    'o': '0',
    'l': '1',
    'i': '1',
    'q': '9',
    'a': '9',
    'n': 'm',
    'v': 'w',
    'b': 'h',
    'e': 'c',
    '6': '0',
};
const safeChars = (alphabets + numbers).replaceAll(RegExp(Object.keys(replacements).join('|'), 'g'), '');


/**
 * Generates a random string ID of the specified length using safe characters.
 *
 * @param length - Length of the generated string.
 * @returns - Randomly generated string ID.
 */
export function randomStringId(length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += safeChars.charAt(Math.floor(Math.random() * safeChars.length));
    }
    return result;
}
