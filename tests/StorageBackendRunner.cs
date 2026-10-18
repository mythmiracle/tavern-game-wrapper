using System;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using NeutralinoSqliteExtension;

public class StorageBackendRunner
{
    public static void Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1024 };
        var store = new SqliteDeltaStore(args[0]);
        try
        {
            var input = Console.In.ReadToEnd();
            var payload = ser.Deserialize<Dictionary<string, object>>(string.IsNullOrEmpty(input) ? "{}" : input);
            object result;
            if (args[1] == "commitSave") result = store.CommitSave(payload, ser);
            else if (args[1] == "prepareChunkSave") result = store.PrepareChunkSave(payload);
            else if (args[1] == "commitChunkSave") result = store.CommitChunkSave(Convert.ToString(payload["id"]));
            else if (args[1] == "chunkMeta") result = store.ExportChunkMeta(payload.ContainsKey("id") ? Convert.ToString(payload["id"]) : null);
            else if (args[1] == "collectChunks") result = store.CollectChunks();
            else if (args[1] == "putChunkBatch") {
                var bytes = new System.Collections.Generic.List<byte>(); foreach (object item in (System.Collections.IEnumerable)payload["bytes"]) bytes.Add(Convert.ToByte(item));
                result = store.PutChunkBatch(Convert.ToString(payload["id"]), bytes.ToArray());
            }
            else if (args[1] == "readChunkBytes") {
                using (var stream = new MemoryStream()) { store.StreamChunkValue(Convert.ToString(payload["key"]), Convert.ToString(payload["id"]), (length, codec) => {}, bytes => stream.Write(bytes, 0, bytes.Length)); result = new Dictionary<string, object> { {"ok", true}, {"base64", Convert.ToBase64String(stream.ToArray())} }; }
            }
            else if (args[1] == "exportMeta") result = store.ExportMeta(ser);
            else if (args[1] == "exportAll") result = store.ExportAll(ser);
            else if (args[1] == "shutdown") result = new Dictionary<string, object> { {"ok", true} };
            else throw new Exception("Unknown test action");
            Console.Write(SqliteDeltaStore.EscapeJsonSurrogates(ser.Serialize(result)));
        }
        catch (Exception exc) { Console.Write(ser.Serialize(new Dictionary<string, object> { {"ok", false}, {"error", exc.Message} })); }
        finally { store.Shutdown(); }
    }
}
