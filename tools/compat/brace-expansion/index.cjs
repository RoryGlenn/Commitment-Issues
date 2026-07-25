// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

"use strict";

// Existing lint dependencies call the legacy package export as a function.
// The maintained implementation exposes that function as a named export.
module.exports = require("brace-expansion-modern").expand;
