import {
    deserialiseFunction,
    isObject,
    uuidv4
} from "./helper.js";

let sqlite3;
let db;
let statements = new Map();

/**
 * The initListener is needed to initialise the Sqlite files.
 * In particular it needs the location of the wasm file which
 * can only consistently be provided from outside the worker
 */
const initListener = addEventListener('message', async ({
    data
}) => {
    const message = data.message;
    if (message.init) {
        self.wasmLocation = message.wasmLocation;
        self.asyncProxyLocation = message.asyncProxyLocation
        if (await initWorker()) {
            postMessage({
                id: data.id,
                result: true
            })
        }
    }
}, {
    once: true
})

/**
 * Initialise the worker by importing the sqlite3.js file and defining the worker API
 */
const initWorker = async () => {
    await import("./sqlite3.js")

    sqlite3 = await sqlite3InitModule();
    if (sqlite3.capi.sqlite3_wasmfs_opfs_dir) {
        sqlite3.capi.sqlite3_wasmfs_opfs_dir();
    }

    addEventListener('message', messageListener)

    return true;
}

const messageListener = async ({
    data
}) => {
    try {
        // extract the request id
        const {
            id,
            message
        } = data;

        console.debug(`Bare SQLITE OPFS > worker retrieved data:`);
        console.debug(message);

        const result = await handleData(message);
        console.debug(`Bare SQLITE OPFS > worker result:`)
        console.debug(result)

        postMessage({
            id,
            result: result
        });
    } catch (error) {
        console.debug('Original error')
        console.debug(error.stack)
        postMessage({
            error: true,
            message: error.message,
            stack: error.stack
        })
    }
}

const handleData = async (data) => {
    /**
     * @todo this sequence of if statements with returns is starting to suck to be honest...
     */

    /**
     * @todo We should extend the original database and statement classes with additional functions
     */

    if (!data || !data.func) {
        throw new Error("No (valid) data provided to the Sqlite OPFS worker");
    }

    /**
     * Initialize event
     */
    if (data.func === "initialize") {
        return initialize(data.filePath);
    }

    /**
     * Clear event
     */
    if (data.func === "clear") {
        return await clearOPFS(data.dbPath);
    }

    /**
     * Statement cleanup event
     */
    if (data.func === "statementCleanup") {
        if (!data.statementId)
            throw new Error(`Bare SQLITE OPFS > running function statementCleanup but no statementID provided, not sure what to cleanup`);

        statements.get(data.statementId).finalize();
        statements.delete(data.statementId);
        return;
    }

    /**
     * To proceed at least a database must have been initialized
     */
    if (!db) {
        throw new Error(`Unable to process ${data.func} because no database has been initiated yet.`);
    }

    /**
     * Prepare event
     */
    if (data.func === "prepare") {
        const result = await db[data.func](...data.args)

        // Add the statement to the statement reference array
        const id = uuidv4();
        statements.set(id, result);

        return {
            statementId: id
        };
    }

    if (data.func === "transaction") {
        /**
         * @todo check the existence of args[0]
         */
        const callbackFunction = deserialiseFunction(data.args[0]);
        const callbackArgs = data.args[1] || {}
        console.debug('Run transaction with callback:')
        console.debug(callbackFunction)
        return db.transaction(() => {
            callbackFunction(db, callbackArgs);
        });
    }

    /**
     * Statement method call
     */
    if (data.statementId) {
        console.debug(`Bare SQLITE OPFS > statement execution of '${data.func}', with args:`)
        console.debug(data.args)

        // Get the statement
        const statement = statements.get(data.statementId);
        if (!statement) {
            throw new Error(`Bare SQLITE OPFS > Trying to execute statement with id '${statementId}', but it doesn't seem to exist anymore.`)
        }

        if (data.func === "all") {
            const result = []
            statement.reset(); // reset to make sure we really get all data
            while (statement.step()) {
                result.push(statement.get({}));
            }
            return result;
        }

        // Execute generic statement call
        const result = await statement[data.func](...data.args);

        // check if the statement has been finalized
        if (!statement.pointer) {
            console.debug(`Bare SQLITE OPFS > Will delete statement '${data.statementId}' from statement collection`);
            statements.delete(data.statementId);
        }

        const resultIsStatement = isObject(result) && "columnCount" in result;

        // check if the statement has been updated, then update statement
        // The pointer of the new and old statement are exactly the same - it makes sense to only keep a reference to the last in our map.
        if (resultIsStatement) {
            console.debug("Bare SQLITE OPFS > Result is still a statement - update and return statement");
            console.debug(result);

            statements.set(data.statementId, result);

            // if the result is still the statement we simply return the statementId 
            // so the client can continue using it 
            return {
                statementId: data.statementId
            };
        }

        return result;
    }

    console.debug(`Bare SQLITE OPFS > perform '${data.func}' on database`)
    return await db[data.func](...data.args)
}

const initialize = (filePath) => {
    if (filePath) {
        db = new sqlite3.opfs.OpfsDb(filePath)
        return true
    } else {
        return new Error("Please provide a filepath")
    }
}

/**
 * @todo make this more granular by allowing to delete only a single database for example. 
 * Use the Google docs [here](https://developer.chrome.com/articles/file-system-access/)
 */
async function clearOPFS() {
    const rootDir = await navigator.storage.getDirectory();
    // @ts-ignore
    for await (const x of rootDir.entries()) {
        console.log(x)
        console.debug(`removing ${name}`);
        await rootDir.removeEntry(name, {
            recursive: true
        }).catch(() => {});
    }
}