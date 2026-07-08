#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");

process.env.WECOM_KF_STATE_DIR ||= path.join(os.homedir(), ".openclaw-wecom-kf");
require("../dashboard/server.cjs");
