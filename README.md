# SalesOrder

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.1.7.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Cloudflare Pages deployment

Production API requests use the Pages Function in `functions\api\frappe-proxy\[[path]].ts`. The `functions\` directory must remain at the repository root; the Pages static output directory is `dist\sales-order\browser`. `public\_routes.json` ensures `/api/frappe-proxy/*` invokes the Function while static files do not. The function forwards Frappe API requests and session cookies to `https://dev04.agrovisions.pk` without logging credentials or cookies.

Build the Angular assets:

```bash
npm run build -- --configuration production
```

Build the Pages Function bundle and route manifest:

```bash
npx wrangler pages functions build functions --outdir .wrangler\pages-function --build-output-directory dist\sales-order\browser --output-routes-path dist\sales-order\browser\_routes.json
```

Run the Pages site and Function locally through Wrangler:

```bash
npx wrangler pages dev dist\sales-order\browser --compatibility-date 2026-11-06
```

In another terminal, confirm the login route reaches Frappe (use only placeholder credentials for this smoke test):

```bash
curl.exe --include --request POST --header "Content-Type: application/json" --data "{\"usr\":\"invalid-test-user\",\"pwd\":\"invalid-test-password\"}" http://127.0.0.1:8788/api/frappe-proxy/api/method/login
```

An upstream Frappe error such as HTTP 401 is expected for placeholder credentials; HTTP 405 from Pages is not.

Deploy assets and Functions together (run from the repository root):

```bash
npx wrangler pages deploy dist\sales-order\browser --project-name sales-order --branch master
```

The Cloudflare Pages Git integration can also deploy both when the build command is `npm run build -- --configuration production`, the output directory is `dist\sales-order\browser`, and the repository-root `functions\` directory is included in the deployment. Set the Pages project root to the repository root. Do not copy `functions\` into `dist\`.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
