import * as path from "path";
import * as Q  from "q";
import * as tl from "vsts-task-lib/task";

import INuGetCommandOptions from "./Common/INuGetCommandOptions";
import locationHelpers = require("nuget-task-common/LocationHelpers");
import {NuGetConfigHelper2} from "nuget-task-common/NuGetConfigHelper2";
import * as ngToolRunner from "nuget-task-common/NuGetToolRunner2";
import * as vstsNuGetPushToolRunner from "./Common/VstsNuGetPushToolRunner";
import * as vstsNuGetPushToolUtilities from "./Common/VstsNuGetPushToolUtilities";
import * as nutil from "nuget-task-common/Utility";
import nuGetGetter = require("nuget-task-common/NuGetToolGetter");
import * as vsts from "vso-node-api/WebApi";
import * as vsom from 'vso-node-api/VsoClient';
import {VersionInfo} from "nuget-task-common/pe-parser/VersionResource";
import {VersionInfoVersion} from "nuget-task-common/pe-parser/VersionInfoVersion";
import * as auth from "nuget-task-common/Authentication";
import { IPackageSource } from "nuget-task-common/Authentication";
import peParser = require('nuget-task-common/pe-parser/index');
import * as commandHelper from "nuget-task-common/CommandHelper";

class PublishOptions implements INuGetCommandOptions {
    constructor(
        public nuGetPath: string,
        public feedUri: string,
        public apiKey: string,
        public configFile: string,
        public verbosity: string,
        public authInfo: auth.NuGetExtendedAuthInfo,
        public environment: ngToolRunner.NuGetEnvironmentSettings
    ) { }
}

interface IVstsNuGetPushOptions {
    vstsNuGetPushPath: string, 
    feedUri: string,
    internalAuthInfo: auth.InternalAuthInfo,
    verbosity: string,
    settings: vstsNuGetPushToolRunner.VstsNuGetPushSettings
}

export async function run(nuGetPath: string): Promise<void> {
    let buildIdentityDisplayName: string = null;
    let buildIdentityAccount: string = null;
    try {
        nutil.setConsoleCodePage();

        // Get list of files to pusblish
        let searchPattern = tl.getPathInput("searchPatternPush", true, false);

        let useLegacyFind: boolean = tl.getVariable("NuGet.UseLegacyFindFiles") === "true";
        let filesList: string[] = [];
        if (!useLegacyFind) {
            let findOptions: tl.FindOptions = <tl.FindOptions>{};
            let matchOptions: tl.MatchOptions = <tl.MatchOptions>{};
            filesList = tl.findMatch(undefined, searchPattern, findOptions, matchOptions);
        }
        else {
            filesList = nutil.resolveFilterSpec(searchPattern);
        }

        filesList.forEach(packageFile => {
            if (!tl.stats(packageFile).isFile()) {
                throw new Error(tl.loc("Error_PushNotARegularFile", packageFile));
            }
        });

        if (filesList && filesList.length < 1)
        {
            tl.setResult(tl.TaskResult.Succeeded, tl.loc("Info_NoPackagesMatchedTheSearchPattern"));
            return;
        }

        // Get the info the type of feed 
        let nugetFeedType = tl.getInput("nuGetFeedType") || "internal";
        // Make sure the feed type is an expected one
        let normalizedNuGetFeedType = ["internal", "external"].find(x => nugetFeedType.toUpperCase() === x.toUpperCase());
        if (!normalizedNuGetFeedType) {
            throw new Error(tl.loc("UnknownFeedType", nugetFeedType));
        }
        nugetFeedType = normalizedNuGetFeedType;
        
        let serviceUri = tl.getEndpointUrl("SYSTEMVSSCONNECTION", false);
        let urlPrefixes = await locationHelpers.assumeNuGetUriPrefixes(serviceUri);
        tl.debug(`discovered URL prefixes: ${urlPrefixes}`);

        // Note to readers: This variable will be going away once we have a fix for the location service for
        // customers behind proxies
        let testPrefixes = tl.getVariable("NuGetTasks.ExtraUrlPrefixesForTesting");
        if (testPrefixes) {
            urlPrefixes = urlPrefixes.concat(testPrefixes.split(";"));
            tl.debug(`all URL prefixes: ${urlPrefixes}`);
        }

        // Setting up auth info
        let externalAuthArr = commandHelper.GetExternalAuthInfoArray("externalEndpoint");
        let accessToken = auth.getSystemAccessToken();
        const quirks = await ngToolRunner.getNuGetQuirksAsync(nuGetPath);
        let credProviderPath = nutil.locateCredentialProvider();
        // Clauses ordered in this way to avoid short-circuit evaluation, so the debug info printed by the functions
        // is unconditionally displayed
        let useCredProvider = ngToolRunner.isCredentialProviderEnabled(quirks) && credProviderPath;
        let useCredConfig = ngToolRunner.isCredentialConfigEnabled(quirks) && !useCredProvider;
        let authInfo = new auth.NuGetExtendedAuthInfo(new auth.InternalAuthInfo(urlPrefixes, accessToken, useCredProvider, useCredConfig), externalAuthArr);

        let environmentSettings: ngToolRunner.NuGetEnvironmentSettings = {
            credProviderFolder: useCredProvider ? path.dirname(credProviderPath) : null,
            extensionsDisabled: true 
            }
        let configFile = null;
        let apiKey: string;
        let credCleanup = () => { return };
        let nuGetConfigHelper = new NuGetConfigHelper2(nuGetPath, null, authInfo, environmentSettings, null);
        let feedUri: string = undefined;
        let isInternalFeed: boolean = nugetFeedType === "internal";

        if (isInternalFeed) 
        {
            let internalFeedId = tl.getInput("feedPublish");
            if (useCredConfig) {
                
                nuGetConfigHelper.addSourcesToTempNuGetConfig([<IPackageSource>{ feedName: internalFeedId, feedUri: feedUri, isInternal: true }]);
                configFile = nuGetConfigHelper.tempNugetConfigPath;
                credCleanup = () => tl.rmRF(nuGetConfigHelper.tempNugetConfigPath);
            }

            apiKey = "VSTS";
            const nuGetVersion: VersionInfo = await peParser.getFileVersionInfoAsync(nuGetPath);
            feedUri = await nutil.getNuGetFeedRegistryUrl(accessToken, internalFeedId, nuGetVersion);
        }
        else {
            let externalAuth = externalAuthArr[0];

            if (!externalAuth)
            {
                tl.setResult(tl.TaskResult.Failed, tl.loc("Error_NoSourceSpecifiedForPush"));
                return;
            }

            nuGetConfigHelper.addSourcesToTempNuGetConfig([externalAuth.packageSource]);
            feedUri = externalAuth.packageSource.feedUri;
            configFile = nuGetConfigHelper.tempNugetConfigPath;
            credCleanup = () => tl.rmRF(nuGetConfigHelper.tempNugetConfigPath);

            let authType: auth.ExternalAuthType = externalAuth.authType;
            switch(authType) {
                case (auth.ExternalAuthType.UsernamePassword):
                case (auth.ExternalAuthType.Token):
                    apiKey = "RequiredApiKey";
                    break;
                case (auth.ExternalAuthType.ApiKey):
                    let apiKeyAuthInfo =  externalAuth as auth.ApiKeyExternalAuthInfo;
                    apiKey = apiKeyAuthInfo.apiKey;
                    break;
                default:
                    break;
            }
        }

        await nuGetConfigHelper.setAuthForSourcesInTempNuGetConfigAsync();

        let verbosity = tl.getInput("verbosityPush");

        let continueOnConflict: boolean = tl.getBoolInput("allowPackageConflicts");
        if (continueOnConflict && commandHelper.isOnPremisesTfs())
        {
            tl.warning(tl.loc("Warning_AllowDuplicatesOnlyAvailableHosted"));
        }

        let useVstsNuGetPush = shouldUseVstsNuGetPush(isInternalFeed, continueOnConflict);
        let vstsPushPath = undefined;
        if (useVstsNuGetPush) {
            vstsPushPath = vstsNuGetPushToolUtilities.getBundledVstsNuGetPushLocation();

            if (!vstsPushPath)
            {
                tl.warning(tl.loc("Warning_FallBackToNuGet"));
            }
        }
    
        try {
            if (useVstsNuGetPush && vstsPushPath) {
                tl.debug('Using VstsNuGetPush.exe to push the packages');
                let vstsNuGetPushSettings = <vstsNuGetPushToolRunner.VstsNuGetPushSettings>
                {
                    continueOnConflict: continueOnConflict
                }

                let publishOptions = <IVstsNuGetPushOptions> {
                    vstsNuGetPushPath: vstsPushPath, 
                    feedUri: feedUri,
                    internalAuthInfo: authInfo.internalAuthInfo,
                    verbosity: verbosity,
                    settings: vstsNuGetPushSettings
                }

                for (const packageFile of filesList) {
                    await publishPackageVstsNuGetPushAsync(packageFile, publishOptions);
                }
            }
            else {
                tl.debug('Using NuGet.exe to push the packages');
                let publishOptions = new PublishOptions(
                    nuGetPath,
                    feedUri,
                    apiKey,
                    configFile,
                    verbosity,
                    authInfo,
                    environmentSettings);

                for (const packageFile of filesList) {

                    await publishPackageNuGetAsync(packageFile, publishOptions, authInfo);
                }
            }

        } finally {
            credCleanup();
        }

        tl.setResult(tl.TaskResult.Succeeded, tl.loc("PackagesPublishedSuccessfully"));

    } catch (err) {
        tl.error(err);

        if (buildIdentityDisplayName || buildIdentityAccount) {
            tl.warning(tl.loc("BuildIdentityPermissionsHint", buildIdentityDisplayName, buildIdentityAccount));
        }

        tl.setResult(tl.TaskResult.Failed, tl.loc("PackagesFailedToPublish"));
    }
}

function publishPackageNuGetAsync(packageFile: string, options: PublishOptions, authInfo: auth.NuGetExtendedAuthInfo): Q.Promise<number> {
    let nugetTool = ngToolRunner.createNuGetToolRunner(options.nuGetPath, options.environment, authInfo);
    nugetTool.arg("push");

    nugetTool.arg(packageFile);
    
    nugetTool.arg("-NonInteractive");

    nugetTool.arg(["-Source", options.feedUri]);

    nugetTool.argIf(options.apiKey, ["-ApiKey", options.apiKey]);

    if (options.configFile) {
        nugetTool.arg("-ConfigFile");
        nugetTool.arg(options.configFile);
    }

    if (options.verbosity && options.verbosity !== "-") {
        nugetTool.arg("-Verbosity");
        nugetTool.arg(options.verbosity);
    }

    return nugetTool.exec();
}

async function publishPackageVstsNuGetPushAsync(packageFile: string, options: IVstsNuGetPushOptions) {
    let vstsNuGetPushTool = vstsNuGetPushToolRunner.createVstsNuGetPushToolRunner(options.vstsNuGetPushPath, options.settings, options.internalAuthInfo);
    vstsNuGetPushTool.arg(packageFile);
    vstsNuGetPushTool.arg(["-Source", options.feedUri]);
    vstsNuGetPushTool.arg(["-AccessToken", options.internalAuthInfo.accessToken]);
    vstsNuGetPushTool.arg("-NonInteractive")

    if (options.verbosity && options.verbosity.toLowerCase() === "detailed") {
        vstsNuGetPushTool.arg(["-Verbosity", "Detailed"]);
    }

    let exitCode: number = await vstsNuGetPushTool.exec();
    if (exitCode === 0)
    {
        return;
    }

    // ExitCode 2 means a push conflict occurred
    if (exitCode === 2 && options.settings.continueOnConflict)
    {
        tl.debug(`A conflict ocurred with package ${packageFile}, ignoring it since "Allow duplicates" was selected.`)
        return;
    }

    throw new Error(tl.loc("Error_UnexpectedErrorVstsNuGetPush"));
}

function shouldUseVstsNuGetPush(isInternalFeed: boolean, conflictsAllowed: boolean): boolean {
    if (!isInternalFeed)
    {   
        tl.debug('Pushing to an external feed so NuGet.exe will be used.');
        return false;
    }

    if (commandHelper.isOnPremisesTfs())
    {
        tl.debug('Pushing to an onPrem environment, only NuGet.exe is supported.');
        return false;
    }

    const nugetOverrideFlag = tl.getVariable("NuGet.ForceNuGetForPush");
    if (nugetOverrideFlag === "true") {
        tl.debug("NuGet.exe is force enabled for publish.");
        if(conflictsAllowed)
        {
            tl.warning(tl.loc("Warning_ForceNuGetCannotSkipConflicts"));
        }
        return false;
    }

    if (nugetOverrideFlag === "false") {
        tl.debug("NuGet.exe is force disabled for publish.");
        return true;
    }

    const vstsNuGetPushOverrideFlag = tl.getVariable("NuGet.ForceVstsNuGetPushForPush");
    if (vstsNuGetPushOverrideFlag === "true") {
        tl.debug("VstsNuGetPush.exe is force enabled for publish.");
        return true;
    }

    if (vstsNuGetPushOverrideFlag === "false") {
        tl.debug("VstsNuGetPush.exe is force disabled for publish.");
        if(conflictsAllowed)
        {
            tl.warning(tl.loc("Warning_ForceNuGetCannotSkipConflicts"));
        }
        return false;
    }

    return true;
}
