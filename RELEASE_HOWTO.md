# Release HOWTO

To release a new version to NPM follow those steps:

## Step 1: Build and commit the source code

Build the source code using:

```npm run build```

and commit the build output found in the `dist` folder if not done already.

## Step 2: Bump the version and tag the commit

From the `master` branch (requires administrative permissions) execute the
following command:

```npm run release```

Lerna will detect changes in the packages and start an interactive prompt to
select the next version (major, minor or patch).

Upon finish, lerna will **create a version commit and push it directly to master and
tag the release**, e.g. `v0.10.0`.

## Step 3: Create a github release

The next step involves creating a Github release. Go to Github releases and
**Draft a new release** by using the tag lerna created:

Tag version: `[v0.10.0]` @ `[Target: master]`

Release title: `[v0.10.0]`

Description: `[Details on what changed during this release]`

## Step 4: Automatic publishing using Github actions

When the release is created, a Github action will be automatically triggered
and the packages will be deployed to NPM.