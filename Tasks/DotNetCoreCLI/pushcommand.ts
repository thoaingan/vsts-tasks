import * as path from "path";
import * as Q  from "q";
import * as tl from "vsts-task-lib/task";

import locationHelpers = require("nuget-task-common/LocationHelpers");
import {NuGetConfigHelper2} from "nuget-task-common/NuGetConfigHelper2";
import * as nutil from "nuget-task-common/Utility";
import * as vsts from "vso-node-api/WebApi";
import * as vsom from 'vso-node-api/VsoClient';
import * as auth from "nuget-task-common/Authentication";
import { IPackageSource } from "nuget-task-common/Authentication";
import * as utility from './Common/utility';
import {IExecOptions} from "vsts-task-lib/toolrunner";
import * as commandHelper from "nuget-task-common/CommandHelper";


export async function run(): Promise<void> {
    let buildIdentityDisplayName: string = null;
    let buildIdentityAccount: string = null;
    try {
        // Get list of files to publish
        const searchPattern = tl.getPathInput("searchPatternPush", true, false);

        let findOptions: tl.FindOptions = <tl.FindOptions>{};
        let matchOptions: tl.MatchOptions = <tl.MatchOptions>{};
        const filesList = tl.findMatch(undefined, searchPattern, findOptions, matchOptions);

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
        let testPrefixes = tl.getVariable("DotNetCoreCLITask.ExtraUrlPrefixesForTesting");
        if (testPrefixes) {
            urlPrefixes = urlPrefixes.concat(testPrefixes.split(";"));
            tl.debug(`all URL prefixes: ${urlPrefixes}`);
        }

        // Setting up auth info
        let externalAuthArr = commandHelper.GetExternalAuthInfoArray("externalEndpoint");
        let accessToken = auth.getSystemAccessToken();

        let authInfo = new auth.NuGetExtendedAuthInfo(new auth.InternalAuthInfo(urlPrefixes, accessToken, /*useCredProvider*/ null, /*useCredConfig*/ true), externalAuthArr);

        let configFile = null;
        let apiKey: string;
        let credCleanup = () => { return };

        const nuGetPath = await utility.getNuGetPath();

        // dotnet nuget push does not currently accept a --config-file parameter
        // so we are going to work around this by creating a temporary working directory for dotnet with
        // a nuget config file it will load by default.
        const tempNuGetConfigDirectory = path.join(NuGetConfigHelper2.getTempNuGetConfigBasePath(), "NuGet_" + tl.getVariable("build.buildId"));
        const tempNuGetPath = path.join(tempNuGetConfigDirectory, "nuget.config");
        tl.mkdirP(tempNuGetConfigDirectory);

        const nuGetConfigHelper = new NuGetConfigHelper2(nuGetPath, null, authInfo, {credProviderFolder: null, extensionsDisabled: true}, tempNuGetPath);
        let feedUri: string = undefined;
        const isInternalFeed: boolean = nugetFeedType === "internal";

        if (isInternalFeed) 
        {
            const internalFeedId = tl.getInput("feedPublish");
            feedUri = await nutil.getNuGetFeedRegistryUrl(accessToken, internalFeedId, null);
            nuGetConfigHelper.addSourcesToTempNuGetConfig([<IPackageSource>{ feedName: internalFeedId, feedUri: feedUri, isInternal: true }]);
            configFile = nuGetConfigHelper.tempNugetConfigPath;
            credCleanup = () => {tl.rmRF(tempNuGetConfigDirectory)};

            apiKey = "VSTS";
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
            credCleanup = () =>  {tl.rmRF(tempNuGetConfigDirectory)};

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

        const dotnetPath = tl.which("dotnet", true);

        try {


            for (const packageFile of filesList) {

                await dotNetNuGetPushAsync(dotnetPath, packageFile, feedUri, apiKey, configFile, tempNuGetConfigDirectory);
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

function dotNetNuGetPushAsync(dotnetPath: string, packageFile: string, feedUri: string, apiKey: string, configFile: string, workingDirectory: string): Q.Promise<number> {
    let dotnet = tl.tool(dotnetPath);

    dotnet.arg("nuget");
    dotnet.arg("push");

    dotnet.arg(packageFile);

    dotnet.arg("--source");
    dotnet.arg(feedUri);

    dotnet.arg("--api-key");
    dotnet.arg(apiKey);

    // dotnet.exe v1 and v2 do not accept the --verbosity parameter for the "nuget push"" command, although it does for other commands

    return dotnet.exec({ cwd: workingDirectory } as IExecOptions);
}
