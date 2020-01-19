const request = require('@nicklason/request-retry');
const semver = require('semver');
const log = require('lib/logger');

const package = require('@root/package.json');

// Maybe save latest notified version to a file?
let lastNotifiedVersion = package.version;

exports.getLatestVersion = function (callback) {
    request({
        method: 'GET',
        url: 'https://raw.githubusercontent.com/Nicklason/tf2-automatic/master/package.json',
        json: true
    }, function (err, response, body) {
        if (err) {
            return callback(err);
        }

        return callback(null, body.version);
    });
};

exports.checkForUpdates = function (callback) {
    if (!callback) {
        callback = noop;
    }

    exports.getLatestVersion(function (err, latestVersion) {
        if (err) {
            log.warn('Failed to check for updates: ', err);
            callback(err);
            return;
        }

        const hasNewVersion = semver.lt(package.version, latestVersion);

        if (lastNotifiedVersion !== latestVersion && hasNewVersion) {
            lastNotifiedVersion = latestVersion;
            require('app/admins').message(`Update available! Current: v${package.version}, Latest: v${latestVersion}.\nSee the wiki for help: https://github.com/Nicklason/tf2-automatic/wiki/Updating`);
        }

        callback(null, hasNewVersion, lastNotifiedVersion, latestVersion);
    });
};

exports.startVersionChecker = function () {
    exports.checkForUpdates();

    // Check for updates every 10 minutes
    setInterval(exports.checkForUpdates, 10 * 60 * 1000);
};

function noop () {}
